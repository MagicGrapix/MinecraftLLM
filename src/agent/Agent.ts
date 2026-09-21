import type { ChatIntentRouter } from "../chat/ChatIntentRouter";
import type {
  ExecutionController,
  ExecutionEvent,
} from "../execution/ExecutionController";
import type { LLMClient, LLMMessage } from "../llm/LLMClient";
import { LLMError } from "../llm/LLMError";
import type { ConversationHistory } from "../memory/ConversationHistory";
import type { RecentActivityBuffer } from "../memory/RecentActivityBuffer";
import type { AgentPrompts } from "../prompts/AgentPrompts";
import { AgentContextBuilder } from "./AgentContextBuilder";
import { AgentMailbox, type AgentWakeEvent } from "./AgentMailbox";
import type { AgentRunState } from "./AgentState";
import { writeTrace } from "../TraceLog";
import {
  AgentToolBridge,
  type AgentPermissionMode,
} from "./AgentToolBridge";
import { WakePolicy } from "./WakePolicy";

interface AgentOptions {
  readonly llm: LLMClient;
  readonly intentRouter: ChatIntentRouter;
  readonly contextBuilder: AgentContextBuilder;
  readonly toolBridge: AgentToolBridge;
  readonly controller: ExecutionController;
  readonly history: ConversationHistory;
  readonly activities: RecentActivityBuffer;
  readonly prompts: Pick<
    AgentPrompts,
    "resumeReview" | "executionFinished" | "executionIdle"
  >;
  readonly maxToolRounds: number;
  readonly temperature: number;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "max";
  readonly maxTokens: number;
  readonly turnTimeoutMs: number;
  readonly respond: (message: string, username?: string) => Promise<void>;
}

export class Agent {
  private readonly mailbox = new AgentMailbox();
  private readonly wakePolicy = new WakePolicy();
  private generationId = 0;
  private manualStopped = false;
  private activeDirective: string | null = null;
  private thinking = false;
  private activeAbort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private shutdownRequested = false;
  private stoppedTaskId: string | null = null;

  constructor(private readonly options: AgentOptions) {}

  start(): void {
    if (this.loopPromise) return;
    this.loopPromise = this.runLoop();
  }

  state(): AgentRunState {
    return {
      manualStopped: this.manualStopped,
      activeDirective: this.activeDirective,
      generationId: this.generationId,
      thinking: this.thinking,
    };
  }

  submitUserMessage(
    username: string,
    text: string,
    readonlyOnly = false,
  ): void {
    if (this.shutdownRequested) return;
    const generationId = this.supersede("New user message.");
    console.info("User message queued for the agent.", {
      generationId,
      username,
      readonlyOnly,
      manualStopped: this.manualStopped,
      message: text,
    });
    this.options.activities.add({
      kind: "user_message",
      summary: `${username}: ${text}`,
      data: { username, text },
    });
    this.mailbox.push({
      type: "user_message",
      username,
      text,
      receivedAt: Date.now(),
      generationId,
      readonlyOnly,
    });
  }

  async requestStop(username: string): Promise<void> {
    if (this.shutdownRequested) return;
    this.supersede("Stopped by user.");
    this.manualStopped = true;
    const before = this.options.controller.snapshot();
    this.stoppedTaskId = before.current?.task.id ?? null;
    this.options.controller.abortCurrent("Stopped by user");
    this.options.activities.add({
      kind: "control",
      summary: `${username} requested stop.`,
      data: { currentTaskId: this.stoppedTaskId },
    });
    console.info("Agent manual stop enabled.", {
      generationId: this.generationId,
      username,
    });
    await this.options.respond("Arrêt demandé.", username);
    if (!this.stoppedTaskId) {
      await this.options.respond("Bot arrêté.", username);
    }
  }

  requestResume(username: string): void {
    if (this.shutdownRequested) return;
    const generationId = this.supersede("Resume requested.");
    this.manualStopped = true;
    this.options.controller.pause();
    console.info("Resume review queued.", {
      generationId,
      username,
      pendingTasks: this.options.controller.snapshot().pending.length,
    });
    this.mailbox.push({
      type: "resume_requested",
      username,
      receivedAt: Date.now(),
      generationId,
    });
  }

  notifyExecutionEvent(event: ExecutionEvent): void {
    if (this.shutdownRequested) return;
    if (event.type === "task_started") {
      this.options.activities.add({
        kind: "task_started",
        summary: `Started ${event.task.capability}.`,
        taskId: event.task.id,
        data: { input: event.task.input },
      });
      return;
    }
    if (event.type === "task_finished") {
      this.options.activities.add({
        kind: "task_finished",
        summary: `${event.task.capability} ${
          event.result.ok ? "succeeded" : "failed"
        }.`,
        taskId: event.task.id,
        data: event.result,
      });
      if (event.task.id === this.stoppedTaskId) {
        this.stoppedTaskId = null;
        void this.options.respond("Bot arrêté.");
        return;
      }
    }

    const wake = this.wakePolicy.fromExecutionEvent(event);
    if (wake) {
      console.debug("Execution event queued as an agent wake.", {
        eventType: event.type,
        revision: event.snapshot.revision,
        taskId: "task" in event ? event.task.id : undefined,
      });
      this.mailbox.push(wake);
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownRequested) {
      await this.loopPromise;
      return;
    }
    this.shutdownRequested = true;
    this.supersede("Agent shutdown.");
    this.mailbox.close();
    await this.loopPromise;
  }

  private async runLoop(): Promise<void> {
    while (!this.shutdownRequested) {
      const wake = await this.mailbox.take();
      if (!wake || this.shutdownRequested) return;
      if (
        (wake.type === "user_message" ||
          wake.type === "resume_requested") &&
        wake.generationId !== this.generationId
      ) {
        console.info("Skipping superseded chat wake.", {
          wakeType: wake.type,
          wakeGenerationId: wake.generationId,
          generationId: this.generationId,
        });
        continue;
      }

      const generationId =
        wake.type === "user_message" ||
        wake.type === "resume_requested"
          ? wake.generationId
          : ++this.generationId;
      await this.runGeneration(wake, generationId);
    }
  }

  private async runGeneration(
    wake: AgentWakeEvent,
    generationId: number,
  ): Promise<void> {
    const abort = new AbortController();
    this.activeAbort = abort;
    this.thinking = true;
    let committedPermission: AgentPermissionMode | null = null;
    let planMutated = false;
    let executionStoppedByTool = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort("Agent turn timed out.");
    }, this.options.turnTimeoutMs);
    const startedAt = Date.now();
    console.info("Agent generation started.", {
      generationId,
      wakeType: wake.type,
      manualStopped: this.manualStopped,
      mailboxSize: this.mailbox.size,
    });

    try {
      const prepared = await this.prepareWake(
        wake,
        generationId,
        abort.signal,
      );
      this.assertCurrent(generationId, abort.signal);
      if (!prepared) return;
      committedPermission = prepared.permission;
      console.debug("Agent wake prepared.", {
        generationId,
        permission: prepared.permission,
        username: prepared.username,
        input: preview(prepared.input),
      });

      const baseMessages = this.options.contextBuilder.build({
        manualStopped: this.manualStopped,
        permission: prepared.permission,
        generationId,
        wakeReason: wake.type,
        activeDirective: this.activeDirective,
        currentInput: prepared.input,
      });
      const messages = [...baseMessages];
      const turnMessages: LLMMessage[] = [
        { role: "user", content: prepared.input },
      ];
      let completed = false;
      let hadToolError = false;

      for (
        let round = 0;
        round <= this.options.maxToolRounds;
        round += 1
      ) {
        const tools = this.options.toolBridge.catalog.build(
          prepared.permission,
        );
        const messageChars = JSON.stringify(messages).length;
        const toolSchemaChars = JSON.stringify(tools).length;
        const llmStartedAt = Date.now();
        console.info("Agent LLM round started.", {
          generationId,
          round,
          permission: prepared.permission,
          messageCount: messages.length,
          messageChars,
          toolCount: tools.length,
          toolSchemaChars,
          estimatedInputChars: messageChars + toolSchemaChars,
          maxOutputTokens: this.options.maxTokens,
          toolNames: tools.map((tool) => tool.name),
        });
        const llmRequest = {
          messages,
          tools,
          temperature: this.options.temperature,
          reasoningEffort: this.options.reasoningEffort,
          maxTokens: this.options.maxTokens,
          signal: abort.signal,
        } as const;
        writeTrace("agent.llm.request", {
          generationId,
          round,
          permission: prepared.permission,
          request: {
            ...llmRequest,
            signal: undefined,
          },
        });
        const response = await this.options.llm.complete(llmRequest);
        this.assertCurrent(generationId, abort.signal);
        writeTrace("agent.llm.response", {
          generationId,
          round,
          permission: prepared.permission,
          response,
        });
        console.info("Agent LLM round completed.", {
          generationId,
          round,
          durationMs: Date.now() - llmStartedAt,
          finishReason: response.finishReason,
          usage: response.usage,
          responseText: preview(response.message.content),
          toolCalls: (response.message.toolCalls ?? []).map((call) => ({
            id: call.id,
            name: call.name,
            arguments: preview(call.arguments),
          })),
        });
        if (response.finishReason === "length") {
          console.warn("Agent LLM output reached the token limit.", {
            generationId,
            round,
            maxTokens: this.options.maxTokens,
            usage: response.usage,
            discardedText: preview(response.message.content),
            discardedToolCalls: (response.message.toolCalls ?? []).map(
              (call) => call.name,
            ),
          });
          await this.options.respond(
            "Ma réflexion a atteint la limite de tokens avant d'être terminée. Je n'exécute pas cette réponse tronquée.",
            prepared.username,
          );
          return;
        }
        messages.push(response.message);
        turnMessages.push(response.message);

        const calls = response.message.toolCalls ?? [];
        if (calls.length === 0) {
          completed = true;
          if (response.message.content?.trim()) {
            await this.options.respond(
              response.message.content.trim(),
              prepared.username,
            );
            this.assertCurrent(generationId, abort.signal);
          }
          break;
        }
        if (round === this.options.maxToolRounds) break;

        for (const call of calls) {
          this.assertCurrent(generationId, abort.signal);
          console.info("Agent tool call started.", {
            generationId,
            round,
            toolCallId: call.id,
            toolName: call.name,
            arguments: preview(call.arguments),
          });
          writeTrace("agent.tool.started", {
            generationId,
            round,
            permission: prepared.permission,
            call,
          });
          const result = await this.options.toolBridge.execute(call, {
            permission: prepared.permission,
            manualStopped: this.manualStopped,
            generationId,
          });
          // Record already-committed side effects before checking whether the
          // generation was superseded while the bridge call was in flight.
          planMutated ||=
            result.ok &&
            (call.name === "enqueue_tasks" ||
              call.name === "replace_pending_tasks" ||
              call.name === "prepend_task" ||
              call.name === "remove_pending_task" ||
              call.name === "clear_pending_tasks");
          executionStoppedByTool ||=
            result.ok &&
            (call.name === "pause_execution" ||
              call.name === "abort_current_task");
          this.assertCurrent(generationId, abort.signal);
          const toolMessage: LLMMessage = {
            role: "tool",
            toolCallId: result.toolCallId,
            content: result.content,
          };
          messages.push(toolMessage);
          turnMessages.push(toolMessage);
          hadToolError ||= !result.ok;
          console.info("Agent tool call completed.", {
            generationId,
            round,
            toolCallId: call.id,
            toolName: call.name,
            ok: result.ok,
            result: preview(result.content),
          });
          writeTrace("agent.tool.completed", {
            generationId,
            round,
            permission: prepared.permission,
            call,
            result,
          });
          this.options.activities.add({
            kind: "tool",
            summary: `${call.name}: ${result.ok ? "ok" : "error"}`,
            data: parseActivityData(result.content),
          });
        }
        // A committed physical plan starts before the next LLM round. This is
        // what lets execution and reflection progress concurrently.
        this.resumeCommittedPlan(
          prepared.permission,
          planMutated,
          executionStoppedByTool,
        );
      }

      if (!completed) {
        console.warn("Agent tool-round limit reached.", {
          generationId,
          maxToolRounds: this.options.maxToolRounds,
          hadToolError,
        });
        await this.options.respond(
          `Je n'ai pas réussi à terminer le plan après ${this.options.maxToolRounds} tours d'outils. J'arrête ce tour pour éviter une boucle.`,
          prepared.username,
        );
        return;
      }
      this.assertCurrent(generationId, abort.signal);
      this.options.history.appendTurn(
        compactTurnForHistory(turnMessages),
      );

      if (wake.type === "resume_requested") {
        if (hadToolError) {
          await this.options.respond(
            "Je reste arrêté : la revalidation du plan a rencontré une erreur.",
            wake.username,
          );
          return;
        }
        const revision = this.options.controller.snapshot().revision;
        this.manualStopped = false;
        const resumed = this.options.controller.resume({
          expectedRevision: revision,
        });
        if (!resumed.ok) {
          this.manualStopped = true;
          await this.options.respond(
            "Je reste arrêté : le plan a changé pendant la vérification.",
            wake.username,
          );
          return;
        }
        await this.options.respond("Reprise confirmée.", wake.username);
      } else if (
        prepared.permission === "planning_stopped" &&
        this.manualStopped
      ) {
        await this.options.respond(
          "Plan préparé ; je reste arrêté jusqu'à resume.",
          prepared.username,
        );
      }
    } catch (error: unknown) {
      const obsolete =
        generationId !== this.generationId ||
        (abort.signal.aborted && !timedOut);
      if (obsolete) {
        console.info("Agent generation cancelled or stale.", {
          generationId,
          wakeType: wake.type,
        });
        return;
      }
      if (timedOut) {
        this.options.activities.add({
          kind: "agent_error",
          summary: "Agent turn timed out.",
        });
        await this.options.respond(
          "Je m'arrête ici : la réflexion a expiré.",
          "username" in wake ? wake.username : undefined,
        );
        return;
      }
      const message =
        error instanceof LLMError
          ? `Ollama indisponible (${error.code}).`
          : "Je n'ai pas pu terminer cette réflexion.";
      this.options.activities.add({
        kind: "agent_error",
        summary: message,
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      await this.options.respond(
        message,
        "username" in wake ? wake.username : undefined,
      );
    } finally {
      clearTimeout(timeout);
      // Cancellation can happen after a queue mutation has committed but
      // before its tool result is added to the conversation. Do not leave that
      // valid plan stranded in a paused queue. A user stop remains sticky and
      // therefore blocks this fallback.
      if (committedPermission) {
        this.resumeCommittedPlan(
          committedPermission,
          planMutated,
          executionStoppedByTool,
        );
      }
      if (this.activeAbort === abort) {
        this.activeAbort = null;
        this.thinking = false;
      }
      console.info("Agent generation finished.", {
        generationId,
        wakeType: wake.type,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  private async prepareWake(
    wake: AgentWakeEvent,
    generationId: number,
    signal: AbortSignal,
  ): Promise<{
    permission: AgentPermissionMode;
    input: string;
    username?: string;
  } | null> {
    if (wake.type === "user_message") {
      const intent = await this.options.intentRouter.route(
        wake.text,
        signal,
      );
      this.assertCurrent(generationId, signal);
      console.info("Chat intent classified.", {
        generationId,
        intent: intent.kind,
        confidence: intent.confidence,
      });
      if (intent.kind === "unclear") {
        await this.options.respond(
          "Peux-tu préciser si tu veux une explication ou une action ?",
          wake.username,
        );
        return null;
      }
      if (intent.kind === "action_request") {
        if (wake.readonlyOnly) {
          await this.options.respond(
            "Seul le propriétaire configuré peut demander une action.",
            wake.username,
          );
          return null;
        }
        this.activeDirective = wake.text;
        return {
          permission: this.manualStopped
            ? "planning_stopped"
            : "acting",
          input: wake.text,
          username: wake.username,
        };
      }
      return {
        permission: "readonly",
        input: wake.text,
        username: wake.username,
      };
    }
    if (wake.type === "resume_requested") {
      return {
        permission: "resume_review",
        input: this.options.prompts.resumeReview.render(),
        username: wake.username,
      };
    }
    if (wake.type === "execution_finished") {
      return {
        permission: this.manualStopped
          ? "planning_stopped"
          : "acting",
        input: this.options.prompts.executionFinished.render({
          task: JSON.stringify(wake.event.task),
          result: JSON.stringify(wake.event.result),
          revision: wake.event.snapshot.revision,
        }),
      };
    }
    if (wake.type === "execution_idle") {
      return {
        permission: this.manualStopped
          ? "planning_stopped"
          : "acting",
        input: this.options.prompts.executionIdle.render({
          revision: wake.event.snapshot.revision,
        }),
      };
    }
    return null;
  }

  private supersede(reason: string): number {
    this.generationId += 1;
    this.activeAbort?.abort(reason);
    return this.generationId;
  }

  private resumeCommittedPlan(
    permission: AgentPermissionMode,
    planMutated: boolean,
    executionStoppedByTool: boolean,
  ): void {
    if (
      permission !== "acting" ||
      !planMutated ||
      executionStoppedByTool ||
      this.manualStopped
    ) {
      return;
    }

    const snapshot = this.options.controller.snapshot();
    if (snapshot.mode !== "paused" || snapshot.pending.length === 0) {
      return;
    }

    const resumed = this.options.controller.resume({
      expectedRevision: snapshot.revision,
    });
    if (!resumed.ok) {
      this.options.activities.add({
        kind: "control_error",
        summary: "A committed plan could not be resumed.",
        data: resumed.error,
      });
      console.warn("Committed execution plan could not be resumed.", {
        revision: snapshot.revision,
        error: resumed.error,
      });
      return;
    }
    console.info("Committed execution plan resumed.", {
      previousRevision: snapshot.revision,
      revision: resumed.snapshot.revision,
      pendingTasks: resumed.snapshot.pending.length,
    });
  }

  private assertCurrent(
    generationId: number,
    signal: AbortSignal,
  ): void {
    signal.throwIfAborted();
    if (generationId !== this.generationId) {
      throw new DOMException("Stale agent generation.", "AbortError");
    }
  }
}

function parseActivityData(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return { malformedToolResult: content.slice(0, 500) };
  }
}

export function compactTurnForHistory(
  messages: readonly LLMMessage[],
): readonly LLMMessage[] {
  const toolNamesById = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      toolNamesById.set(call.id, call.name);
    }
  }

  return messages.map((message) => {
    if (
      message.role !== "tool" ||
      toolNamesById.get(message.toolCallId) !== "get_capability_schemas"
    ) {
      return structuredClone(message);
    }

    const parsed = parseJsonRecord(message.content);
    if (parsed?.ok !== true) return structuredClone(message);
    const value = parseRecord(parsed.value);
    const capabilities = Array.isArray(value?.capabilities)
      ? value.capabilities
      : [];
    const loaded = capabilities.flatMap((capability) => {
      const record = parseRecord(capability);
      return typeof record?.name === "string" ? [record.name] : [];
    });
    return {
      role: "tool",
      toolCallId: message.toolCallId,
      content: JSON.stringify({
        ok: true,
        value: {
          loadedCapabilitySchemas: loaded,
          schemasOmittedFromHistory: true,
        },
      }),
    };
  });
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return parseRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function preview(value: string | null | undefined, maxLength = 800): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength)}…`;
}
