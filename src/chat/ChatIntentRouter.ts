import { z } from "zod";
import type { LLMClient } from "../llm/LLMClient";
import type { PromptTemplate } from "../prompts/PromptTemplate";
import type { ChatIntent } from "./ChatIntent";

const IntentSchema = z
  .object({
    kind: z.enum([
      "readonly_question",
      "action_request",
      "conversation",
      "unclear",
    ]),
    confidence: z.number().int().min(1).max(5),
  })
  .strict();

export class ChatIntentRouter {
  constructor(
    private readonly llm: LLMClient,
    private readonly prompt: PromptTemplate,
    private readonly confidenceThreshold = 3,
  ) {}

  async route(text: string, signal?: AbortSignal): Promise<ChatIntent> {
    const normalized = text.trim().replace(/\s+/g, " ");
    const startedAt = Date.now();
    console.debug("Intent classification started.", {
      message: normalized,
      confidenceThreshold: this.confidenceThreshold,
      prompt: this.prompt.sourcePath,
    });

    const response = await this.llm.complete({
      messages: [
        { role: "system", content: this.prompt.render() },
        { role: "user", content: normalized },
      ],
      responseFormat: "json_object",
      reasoningEffort: "none",
      temperature: 0,
      maxTokens: 160,
      signal,
    });
    signal?.throwIfAborted();
    console.debug("Intent classification response received.", {
      durationMs: Date.now() - startedAt,
      finishReason: response.finishReason,
      usage: response.usage,
      content: response.message.content,
    });
    if (!response.message.content) {
      console.warn("Intent classification returned empty content.");
      return { kind: "unclear", confidence: 1 };
    }

    try {
      const parsed = IntentSchema.parse(
        parseJsonObject(response.message.content),
      );
      if (
        parsed.kind !== "unclear" &&
        parsed.confidence < this.confidenceThreshold
      ) {
        console.info("Intent confidence is below the action threshold.", {
          classifiedKind: parsed.kind,
          confidence: parsed.confidence,
          threshold: this.confidenceThreshold,
        });
        return { kind: "unclear", confidence: parsed.confidence };
      }
      return parsed;
    } catch (error: unknown) {
      console.warn("Intent classification output was invalid.", {
        content: response.message.content,
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: "unclear", confidence: 1 };
    }
  }
}

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    if (fenced?.[1]) return JSON.parse(fenced[1]);

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("The classifier response does not contain a JSON object.");
  }
}
