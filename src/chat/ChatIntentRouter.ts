import { z } from "zod";
import type { LLMClient } from "../llm/LLMClient";
import { INTENT_CLASSIFIER_PROMPT } from "../agent/prompts";
import type { ChatIntent } from "./ChatIntent";

const IntentSchema = z
  .object({
    kind: z.enum([
      "readonly_question",
      "action_request",
      "conversation",
      "unclear",
    ]),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const actionPattern =
  /\b(construis|construire|fabrique|fabriquer|craft|va|vas|viens|creuse|mine|attaque|ouvre|ferme|prends|pose|donne|mange|utilise|déplace|ramasse|build|make|go|dig|attack|open|close|take|place|eat|use)\b/i;
const politeActionPattern =
  /\b(est[- ]ce que tu peux|peux[- ]tu|pourrais[- ]tu|can you|could you)\b/i;
const readonlyPattern =
  /^(comment|pourquoi|où|quel|quelle|quels|quelles|combien|what|why|where|how)\b/i;
const explanatoryQuestionPattern =
  /\b(comment|expliqu(?:e|er|es|ez)|décri(?:s|re|vez)|dis[- ]moi comment|how|explain|describe)\b/i;

export class ChatIntentRouter {
  constructor(
    private readonly llm: LLMClient,
    private readonly confidenceThreshold = 0.7,
  ) {}

  async route(text: string, signal?: AbortSignal): Promise<ChatIntent> {
    const normalized = text.trim().replace(/\s+/g, " ");
    const deterministic = routeDeterministically(normalized);
    if (deterministic) return deterministic;

    const response = await this.llm.complete({
      messages: [
        { role: "system", content: INTENT_CLASSIFIER_PROMPT },
        { role: "user", content: normalized },
      ],
      temperature: 0,
      maxTokens: 80,
      signal,
    });
    signal?.throwIfAborted();
    if (!response.message.content) {
      return { kind: "unclear", confidence: 0 };
    }

    try {
      const parsed = IntentSchema.parse(
        JSON.parse(response.message.content),
      );
      if (parsed.confidence < this.confidenceThreshold) {
        return { kind: "unclear", confidence: parsed.confidence };
      }
      return parsed;
    } catch {
      return { kind: "unclear", confidence: 0 };
    }
  }
}

function routeDeterministically(text: string): ChatIntent | null {
  const lower = text.toLocaleLowerCase("fr");
  if (
    lower === "attends" ||
    lower === "attend" ||
    lower === "wait"
  ) {
    return { kind: "unclear", confidence: 1 };
  }
  // Explanatory wording wins over polite action wording. This is deliberately
  // conservative: a mixed/ambiguous request must not receive mutation tools.
  if (
    explanatoryQuestionPattern.test(text) ||
    readonlyPattern.test(text) ||
    lower === "où" ||
    lower.startsWith("où ")
  ) {
    return { kind: "readonly_question", confidence: 0.95 };
  }
  if (politeActionPattern.test(text) && actionPattern.test(text)) {
    return { kind: "action_request", confidence: 0.98 };
  }
  if (actionPattern.test(text)) {
    return { kind: "action_request", confidence: 0.9 };
  }
  if (/^(salut|bonjour|hello|merci|thanks)\b/i.test(text)) {
    return { kind: "conversation", confidence: 0.95 };
  }
  return null;
}
