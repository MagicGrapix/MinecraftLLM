import type { LLMRequestTrace, LLMResponse } from "../llm/LLMClient";
import { describeInspectorRound } from "./InspectorPresentation";
import type {
  InspectorRound,
  InspectorRoundStatus,
  InspectorRoundSummary,
  InspectorStatus,
  InspectorToolExecution,
} from "./InspectorTypes";

export interface BeginRoundInput {
  readonly generationId: number;
  readonly phase: InspectorRound["phase"];
  readonly reflection: number;
  readonly round: number;
  readonly attempt: number;
  readonly wakeType: string;
  readonly permission: string;
  readonly contextSnapshot?: unknown;
  readonly metrics?: InspectorRound["metrics"];
}

export interface InspectorRoundAnnotation {
  readonly decision?: unknown;
  readonly memoryBefore?: string;
  readonly memoryAfter?: string;
  readonly validationError?: string;
}

export class AgentInspector {
  private readonly drafts = new Map<string, MutableRound>();
  private readonly finalized: InspectorRound[] = [];
  private nextSequence = 0;
  private latestGenerationId: number | null = null;
  private readonly callCounts = new Map<number, number>();
  readonly sessionId: string;

  constructor(
    private readonly maxRounds = 30,
    sessionId = `${Date.now()}_${process.pid}`,
  ) {
    if (!Number.isInteger(maxRounds) || maxRounds < 1) {
      throw new Error("maxRounds must be a positive integer.");
    }
    this.sessionId = sessionId;
  }

  beginRound(input: BeginRoundInput): string {
    const id = this.roundId(input);
    const existing = this.drafts.get(id);
    if (existing && existing.status === "in_progress") {
      return id;
    }
    const callIndex = (this.callCounts.get(input.generationId) ?? 0) + 1;
    this.callCounts.set(input.generationId, callIndex);
    this.latestGenerationId = input.generationId;
    const draft: MutableRound = {
      id,
      timestamp: Date.now(),
      sequence: ++this.nextSequence,
      callIndex,
      generationId: input.generationId,
      phase: input.phase,
      reflection: input.reflection,
      round: input.round,
      attempt: input.attempt,
      wakeType: input.wakeType,
      permission: input.permission,
      ...(input.contextSnapshot === undefined
        ? {}
        : { contextSnapshot: structuredClone(input.contextSnapshot) }),
      status: "in_progress",
      ...(input.metrics ? { metrics: structuredClone(input.metrics) } : {}),
      toolExecutions: [],
    };
    this.drafts.set(id, draft);
    return id;
  }

  recordRequest(
    trace: LLMRequestTrace,
    requestBody: Record<string, unknown>,
  ): void {
    const draft = this.ensureDraft(trace);
    const safeBody = stripSecrets(
      structuredClone(requestBody),
    ) as Record<string, unknown>;
    draft.requestBody = safeBody;
    draft.request = {
      model: typeof safeBody.model === "string" ? safeBody.model : "",
      messages: Array.isArray(safeBody.messages)
        ? (safeBody.messages as unknown[])
        : [],
      tools: Array.isArray(safeBody.tools)
        ? (safeBody.tools as unknown[])
        : [],
      ...(typeof safeBody.temperature === "number"
        ? { temperature: safeBody.temperature }
        : {}),
      ...(typeof safeBody.max_tokens === "number"
        ? { maxTokens: safeBody.max_tokens }
        : {}),
      ...(typeof safeBody.reasoning_effort === "string"
        ? { reasoningEffort: safeBody.reasoning_effort }
        : {}),
      ...(isRecord(safeBody.response_format) &&
      typeof safeBody.response_format.type === "string"
        ? { responseFormat: safeBody.response_format.type }
        : {}),
    };
    if (!draft.metrics) {
      const messagesJson = JSON.stringify(draft.request.messages);
      const toolsJson = JSON.stringify(draft.request.tools);
      draft.metrics = {
        messageCount: draft.request.messages.length,
        messageChars: messagesJson.length,
        toolCount: draft.request.tools.length,
        toolSchemaChars: toolsJson.length,
        estimatedInputChars: messagesJson.length + toolsJson.length,
      };
    }
  }

  recordResponse(
    trace: LLMRequestTrace,
    response: LLMResponse,
    raw?: unknown,
  ): void {
    const draft = this.ensureDraft(trace);
    draft.response = {
      content: response.message.content,
      ...(response.reasoning === undefined
        ? {}
        : { reasoning: response.reasoning }),
      toolCalls: structuredClone(
        (response.message.toolCalls ?? []) as unknown[],
      ),
      finishReason: response.finishReason,
      ...(response.usage
        ? { usage: structuredClone(response.usage) }
        : {}),
    };
    if (raw !== undefined) {
      draft.rawResponse = stripSecrets(structuredClone(raw));
    }
  }

  recordError(trace: LLMRequestTrace, error: string): void {
    const draft = this.ensureDraft(trace);
    draft.error = error;
  }

  recordToolStarted(
    trace: LLMRequestTrace,
    execution: Pick<
      InspectorToolExecution,
      "toolCallId" | "name" | "arguments"
    >,
  ): void {
    const draft = this.requireDraft(trace);
    const index = draft.toolExecutions.findIndex(
      (item) => item.toolCallId === execution.toolCallId,
    );
    const row: MutableToolExecution = {
      toolCallId: execution.toolCallId,
      name: execution.name,
      arguments: execution.arguments,
    };
    if (index >= 0) {
      draft.toolExecutions[index] = row;
    } else {
      draft.toolExecutions.push(row);
    }
  }

  recordToolCompleted(
    trace: LLMRequestTrace,
    execution: InspectorToolExecution,
  ): void {
    const draft = this.requireDraft(trace);
    const index = draft.toolExecutions.findIndex(
      (item) => item.toolCallId === execution.toolCallId,
    );
    const row: MutableToolExecution = {
      toolCallId: execution.toolCallId,
      name: execution.name,
      arguments: execution.arguments,
      ...(execution.result === undefined ? {} : { result: execution.result }),
      ...(execution.ok === undefined ? {} : { ok: execution.ok }),
    };
    if (index >= 0) {
      draft.toolExecutions[index] = row;
    } else {
      draft.toolExecutions.push(row);
    }
  }

  finalizeRound(
    trace: LLMRequestTrace,
    status: Exclude<InspectorRoundStatus, "in_progress">,
  ): InspectorRound | null {
    const id = this.roundId(trace);
    const draft = this.drafts.get(id);
    if (!draft) return null;
    if (draft.status !== "in_progress") {
      return this.getRound(id);
    }
    draft.status = status;
    const snapshot = freezeDeep(cloneRound(draft));
    this.drafts.delete(id);
    this.finalized.push(snapshot);
    this.finalized.sort((a, b) => a.sequence - b.sequence);
    while (this.finalized.length > this.maxRounds) {
      this.finalized.shift();
    }
    this.pruneCallCounts();
    return snapshot;
  }

  finalizeOpenRounds(
    generationId: number,
    status: "superseded" | "aborted" | "error",
    error?: string,
  ): void {
    for (const draft of [...this.drafts.values()]) {
      if (draft.generationId !== generationId) continue;
      if (draft.status !== "in_progress") continue;
      if (error !== undefined) draft.error = error;
      this.finalizeRound(toTrace(draft), status);
    }
  }

  annotate(
    trace: LLMRequestTrace,
    annotation: InspectorRoundAnnotation,
  ): void {
    const draft = this.requireDraft(trace);
    if (annotation.decision !== undefined) {
      draft.decision = structuredClone(annotation.decision);
    }
    if (annotation.memoryBefore !== undefined) {
      draft.memoryBefore = annotation.memoryBefore;
    }
    if (annotation.memoryAfter !== undefined) {
      draft.memoryAfter = annotation.memoryAfter;
    }
    if (annotation.validationError !== undefined) {
      draft.validationError = annotation.validationError;
    }
  }

  listRounds(): InspectorRoundSummary[] {
    return this.finalized.map(toSummary);
  }

  clearRounds(): number {
    if (this.drafts.size > 0) {
      throw new Error("Cannot clear inspector rounds while an LLM request is in progress.");
    }
    const cleared = this.finalized.length;
    this.finalized.length = 0;
    this.pruneCallCounts();
    return cleared;
  }

  getRound(id: string): InspectorRound | null {
    const found = this.finalized.find((round) => round.id === id);
    return found ? freezeDeep(structuredClone(found)) : null;
  }

  status(): InspectorStatus {
    const inProgress = [...this.drafts.values()]
      .filter((draft) => draft.status === "in_progress")
      .map((draft) => ({
        id: draft.id,
        generationId: draft.generationId,
        callIndex: draft.callIndex,
        phase: draft.phase,
        reflection: draft.reflection,
        round: draft.round,
        attempt: draft.attempt,
      }));
    return {
      enabled: true,
      sessionId: this.sessionId,
      maxRounds: this.maxRounds,
      finalizedCount: this.finalized.length,
      inProgressCount: inProgress.length,
      latestRoundId:
        this.finalized.length > 0
          ? this.finalized[this.finalized.length - 1]!.id
          : null,
      inProgress,
    };
  }

  private roundId(
    input: Pick<
      LLMRequestTrace,
      "generationId" | "phase" | "reflection" | "round" | "attempt"
    >,
  ): string {
    return [
      this.sessionId,
      input.generationId,
      input.phase,
      input.reflection,
      input.round,
      input.attempt,
    ].join(":");
  }

  private pruneCallCounts(): void {
    const retained = new Set([
      this.latestGenerationId,
      ...this.finalized.map((round) => round.generationId),
      ...[...this.drafts.values()].map((round) => round.generationId),
    ]);
    for (const generationId of this.callCounts.keys()) {
      if (!retained.has(generationId)) this.callCounts.delete(generationId);
    }
  }

  private ensureDraft(trace: LLMRequestTrace): MutableRound {
    const id = this.roundId(trace);
    const existing = this.drafts.get(id);
    if (existing && existing.status === "in_progress") return existing;
    this.beginRound({
      generationId: trace.generationId,
      phase: trace.phase,
      reflection: trace.reflection,
      round: trace.round,
      attempt: trace.attempt,
      wakeType: trace.wakeType,
      permission: trace.permission,
      ...(trace.contextSnapshot === undefined
        ? {}
        : { contextSnapshot: trace.contextSnapshot }),
    });
    return this.drafts.get(id)!;
  }

  private requireDraft(trace: LLMRequestTrace): MutableRound {
    const id = this.roundId(trace);
    const draft = this.drafts.get(id);
    if (!draft || draft.status !== "in_progress") {
      throw new Error(`No in-progress inspector round for ${id}.`);
    }
    return draft;
  }
}

interface MutableToolExecution {
  toolCallId: string;
  name: string;
  arguments: string;
  result?: string;
  ok?: boolean;
}

interface MutableRound {
  id: string;
  timestamp: number;
  sequence: number;
  callIndex: number;
  generationId: number;
  phase: InspectorRound["phase"];
  reflection: number;
  round: number;
  attempt: number;
  wakeType: string;
  permission: string;
  status: InspectorRoundStatus;
  contextSnapshot?: unknown;
  decision?: unknown;
  memoryBefore?: string;
  memoryAfter?: string;
  validationError?: string;
  request?: InspectorRound["request"];
  requestBody?: Record<string, unknown>;
  metrics?: InspectorRound["metrics"];
  response?: InspectorRound["response"];
  rawResponse?: unknown;
  toolExecutions: MutableToolExecution[];
  error?: string;
}

function cloneRound(draft: MutableRound): InspectorRound {
  return {
    id: draft.id,
    timestamp: draft.timestamp,
    sequence: draft.sequence,
    callIndex: draft.callIndex,
    generationId: draft.generationId,
    phase: draft.phase,
    reflection: draft.reflection,
    round: draft.round,
    attempt: draft.attempt,
    wakeType: draft.wakeType,
    permission: draft.permission,
    status: draft.status,
    ...(draft.contextSnapshot === undefined
      ? {}
      : { contextSnapshot: structuredClone(draft.contextSnapshot) }),
    ...(draft.decision === undefined
      ? {}
      : { decision: structuredClone(draft.decision) }),
    ...(draft.memoryBefore === undefined
      ? {}
      : { memoryBefore: draft.memoryBefore }),
    ...(draft.memoryAfter === undefined
      ? {}
      : { memoryAfter: draft.memoryAfter }),
    ...(draft.validationError === undefined
      ? {}
      : { validationError: draft.validationError }),
    ...(draft.request
      ? { request: structuredClone(draft.request) }
      : {}),
    ...(draft.requestBody
      ? { requestBody: structuredClone(draft.requestBody) }
      : {}),
    ...(draft.metrics
      ? { metrics: structuredClone(draft.metrics) }
      : {}),
    ...(draft.response
      ? { response: structuredClone(draft.response) }
      : {}),
    ...(draft.rawResponse === undefined
      ? {}
      : { rawResponse: structuredClone(draft.rawResponse) }),
    toolExecutions: structuredClone(draft.toolExecutions),
    ...(draft.error === undefined ? {} : { error: draft.error }),
    ...describeInspectorRound(draft),
  };
}

function toTrace(draft: MutableRound): LLMRequestTrace {
  return {
    generationId: draft.generationId,
    phase: draft.phase,
    reflection: draft.reflection,
    round: draft.round,
    attempt: draft.attempt,
    wakeType: draft.wakeType,
    permission: draft.permission,
    ...(draft.contextSnapshot === undefined
      ? {}
      : { contextSnapshot: structuredClone(draft.contextSnapshot) }),
  };
}

function toSummary(round: InspectorRound): InspectorRoundSummary {
  return {
    id: round.id,
    timestamp: round.timestamp,
    sequence: round.sequence,
    callIndex: round.callIndex,
    generationId: round.generationId,
    phase: round.phase,
    reflection: round.reflection,
    round: round.round,
    attempt: round.attempt,
    wakeType: round.wakeType,
    permission: round.permission,
    status: round.status,
    preview: `${round.activity} — ${round.outcome}`.slice(0, 160),
    requestTitle: round.requestTitle,
    agentLabel: round.agentLabel,
    ...(round.stepLabel ? { stepLabel: round.stepLabel } : {}),
    activity: round.activity,
    outcome: round.outcome,
    failed: round.failed,
    ...(round.metrics
      ? {
          messageCount: round.metrics.messageCount,
          toolCount: round.metrics.toolCount,
        }
      : {}),
    toolExecutionCount: round.toolExecutions.length,
    ...(round.response
      ? { finishReason: round.response.finishReason }
      : {}),
    ...(round.response?.usage?.promptTokens === undefined
      ? {}
      : { promptTokens: round.response.usage.promptTokens }),
    ...(round.response?.usage?.completionTokens === undefined
      ? {}
      : { completionTokens: round.response.usage.completionTokens }),
    ...(round.response?.usage?.totalTokens === undefined
      ? {}
      : { totalTokens: round.response.usage.totalTokens }),
  };
}

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripSecrets);
  }
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("apikey") ||
      lower.includes("api_key") ||
      lower === "authorization" ||
      lower === "trace" ||
      lower === "signal"
    ) {
      continue;
    }
    result[key] = stripSecrets(child);
  }
  return result;
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeDeep(child);
  }
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
