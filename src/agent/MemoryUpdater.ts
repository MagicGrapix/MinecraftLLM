import { z } from "zod";
import type { AgentInspector } from "../debug/AgentInspector";
import type {
  LLMClient,
  LLMRequestTrace,
  LLMResponse,
} from "../llm/LLMClient";
import type { PromptTemplate } from "../prompts/PromptTemplate";
import { parseJsonObjectText } from "../shared/helper";
import type { WorkingMemory } from "./WorkingMemory";
import { ModelResponseError } from "./ModelResponseError";

export interface MemoryUpdateInput {
  readonly runId: number;
  readonly reflection: number;
  readonly round?: number;
  readonly oldMemory: string;
  readonly context: unknown;
  readonly agentResponse: LLMResponse;
  readonly toolResults: readonly unknown[];
  readonly actionOutcome?: unknown;
  readonly signal: AbortSignal;
}

interface MemoryUpdaterOptions {
  readonly llm: LLMClient;
  readonly prompt: PromptTemplate;
  readonly memory: WorkingMemory;
  readonly maxRetries: number;
  readonly maxTokens: number;
  readonly inspector?: AgentInspector;
  readonly notifyRetry: (message: string) => Promise<void>;
}

export class MemoryUpdater {
  constructor(private readonly options: MemoryUpdaterOptions) {}

  async update(input: MemoryUpdateInput): Promise<string> {
    const schema = z
      .object({
        memory: z.string().max(this.options.memory.maxLength),
      })
      .strict();
    let correction: string | null = null;

    for (
      let attempt = 0;
      attempt <= this.options.maxRetries;
      attempt += 1
    ) {
      input.signal.throwIfAborted();
      const trace: LLMRequestTrace = {
        generationId: input.runId,
        phase: "memory",
        reflection: input.reflection,
        round: input.round ?? 0,
        attempt,
        wakeType: "memory_update",
        permission: "memory",
        contextSnapshot: {
          memoryBefore: input.oldMemory,
          context: input.context,
          actionOutcome: input.actionOutcome ?? null,
        },
      };
      this.options.inspector?.beginRound(trace);
      this.options.inspector?.annotate(trace, {
        memoryBefore: input.oldMemory,
      });

      try {
        const response = await this.options.llm.complete({
          messages: [
            {
              role: "system",
              content: this.options.prompt.render({
                max_chars: this.options.memory.maxLength,
                memory_input: {
                  oldMemory: input.oldMemory,
                  context: input.context,
                  agentResponse: input.agentResponse,
                  toolResults: input.toolResults,
                  actionOutcome: input.actionOutcome ?? null,
                },
              }),
            },
            ...(correction
              ? [
                  {
                    role: "user" as const,
                    content: `Correct the previous format error: ${correction}`,
                  },
                ]
              : []),
          ],
          responseFormat: "json_object",
          reasoningEffort: "none",
          temperature: 0,
          maxTokens: Math.min(this.options.maxTokens, 1_024),
          signal: input.signal,
          trace,
        });
        input.signal.throwIfAborted();
        if (!response.message.content) {
          throw new ModelResponseError(
            "Memory response content must be a JSON object.",
          );
        }
        const parsed = schema.safeParse(
          parseMemoryJson(response.message.content),
        );
        if (!parsed.success) {
          throw new ModelResponseError(
            parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
          );
        }
        this.options.memory.replace(parsed.data.memory);
        this.options.inspector?.annotate(trace, {
          memoryAfter: this.options.memory.read(),
        });
        this.options.inspector?.finalizeRound(trace, "completed");
        return this.options.memory.read();
      } catch (error: unknown) {
        if (
          input.signal.aborted ||
          !(error instanceof ModelResponseError)
        ) {
          this.options.inspector?.finalizeRound(trace, "error");
          throw error;
        }
        correction = error.message;
        this.options.inspector?.annotate(trace, {
          validationError: correction,
        });
        this.options.inspector?.finalizeRound(trace, "invalid_response");
        if (attempt >= this.options.maxRetries) {
          throw new ModelResponseError(
            `Invalid memory response after ${attempt + 1} attempts: ${correction}`,
          );
        }
        await this.options.notifyRetry(
          `[Bot] Invalid memory response. Retrying (${attempt + 1}/${this.options.maxRetries}).`,
        );
      }
    }

    throw new ModelResponseError("Memory update retries exhausted.");
  }
}

function parseMemoryJson(content: string): unknown {
  try {
    return parseJsonObjectText(content);
  } catch (error: unknown) {
    throw new ModelResponseError(
      error instanceof Error ? error.message : String(error),
    );
  }
}
