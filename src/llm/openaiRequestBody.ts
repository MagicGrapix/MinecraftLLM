import type { LLMMessage, LLMRequest } from "./LLMClient";

/**
 * Builds the exact OpenAI-compatible chat.completions body sent to the provider.
 * Local-only fields such as `trace` and `signal` are never included.
 */
export function buildOpenAIRequestBody(
  request: LLMRequest,
  model: string,
): Record<string, unknown> {
  return {
    model,
    messages: request.messages.map(toOpenAIMessage),
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }
      : {}),
    ...(request.responseFormat === undefined
      ? {}
      : {
          response_format: {
            type: request.responseFormat,
          },
        }),
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoning_effort: request.reasoningEffort }),
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.maxTokens === undefined
      ? {}
      : { max_tokens: request.maxTokens }),
  };
}

export function toOpenAIMessage(message: LLMMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: message.role,
      content: message.content,
      ...(message.toolCalls && message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: call.arguments,
              },
            })),
          }
        : {}),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  return { role: message.role, content: message.content };
}
