import type { LLMRequestTrace, LLMResponse } from "../llm/LLMClient";
import type {
  InspectorRound,
  InspectorRoundStatus,
  InspectorRoundSummary,
  InspectorStatus,
  InspectorToolExecution,
} from "./InspectorTypes";

export interface BeginRoundInput {
  readonly generationId: number;
  readonly round: number;
  readonly wakeType: string;
  readonly permission: string;
  readonly executionRevision?: number;
  readonly eventRevision?: number;
  readonly metrics?: InspectorRound["metrics"];
}

export class AgentInspector {
  private readonly drafts = new Map<string, MutableRound>();
  private readonly finalized: InspectorRound[] = [];
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
    const id = this.roundId(input.generationId, input.round);
    const existing = this.drafts.get(id);
    if (existing && existing.status === "in_progress") {
      return id;
    }
    const draft: MutableRound = {
      id,
      timestamp: Date.now(),
      generationId: input.generationId,
      round: input.round,
      wakeType: input.wakeType,
      permission: input.permission,
      ...(input.executionRevision === undefined
        ? {}
        : { executionRevision: input.executionRevision }),
      ...(input.eventRevision === undefined
        ? {}
        : { eventRevision: input.eventRevision }),
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
    generationId: number,
    round: number,
    execution: Pick<
      InspectorToolExecution,
      "toolCallId" | "name" | "arguments"
    >,
  ): void {
    const draft = this.requireDraft(generationId, round);
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
    generationId: number,
    round: number,
    execution: InspectorToolExecution,
  ): void {
    const draft = this.requireDraft(generationId, round);
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
    generationId: number,
    round: number,
    status: Exclude<InspectorRoundStatus, "in_progress">,
  ): InspectorRound | null {
    const id = this.roundId(generationId, round);
    const draft = this.drafts.get(id);
    if (!draft) return null;
    if (draft.status !== "in_progress") {
      return this.getRound(id);
    }
    draft.status = status;
    const snapshot = freezeDeep(cloneRound(draft));
    this.drafts.delete(id);
    this.finalized.push(snapshot);
    while (this.finalized.length > this.maxRounds) {
      this.finalized.shift();
    }
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
      this.finalizeRound(generationId, draft.round, status);
    }
  }

  listRounds(): InspectorRoundSummary[] {
    return this.finalized.map(toSummary);
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
        round: draft.round,
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

  private roundId(generationId: number, round: number): string {
    return `${this.sessionId}:${generationId}:${round}`;
  }

  private ensureDraft(trace: LLMRequestTrace): MutableRound {
    const id = this.roundId(trace.generationId, trace.round);
    const existing = this.drafts.get(id);
    if (existing && existing.status === "in_progress") return existing;
    this.beginRound({
      generationId: trace.generationId,
      round: trace.round,
      wakeType: trace.wakeType,
      permission: trace.permission,
      ...(trace.executionRevision === undefined
        ? {}
        : { executionRevision: trace.executionRevision }),
      ...(trace.eventRevision === undefined
        ? {}
        : { eventRevision: trace.eventRevision }),
    });
    return this.drafts.get(id)!;
  }

  private requireDraft(
    generationId: number,
    round: number,
  ): MutableRound {
    const id = this.roundId(generationId, round);
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
  generationId: number;
  round: number;
  wakeType: string;
  permission: string;
  executionRevision?: number;
  eventRevision?: number;
  status: InspectorRoundStatus;
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
    generationId: draft.generationId,
    round: draft.round,
    wakeType: draft.wakeType,
    permission: draft.permission,
    ...(draft.executionRevision === undefined
      ? {}
      : { executionRevision: draft.executionRevision }),
    ...(draft.eventRevision === undefined
      ? {}
      : { eventRevision: draft.eventRevision }),
    status: draft.status,
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
  };
}

function toSummary(round: InspectorRound): InspectorRoundSummary {
  const preview =
    round.response?.content?.trim() ||
    round.error ||
    (round.response?.toolCalls.length
      ? `${round.response.toolCalls.length} tool call(s)`
      : round.request
        ? `${round.request.messages.length} message(s)`
        : round.status);
  return {
    id: round.id,
    timestamp: round.timestamp,
    generationId: round.generationId,
    round: round.round,
    wakeType: round.wakeType,
    permission: round.permission,
    status: round.status,
    preview: preview.slice(0, 120),
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
