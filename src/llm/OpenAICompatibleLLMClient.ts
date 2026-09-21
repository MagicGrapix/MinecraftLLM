import OpenAI from "openai";
import type {
  LLMClient,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
} from "./LLMClient";
import { LLMError } from "./LLMError";

export interface OpenAICompatibleLLMClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly requestTimeoutMs: number;
  readonly maxRetries?: number;
}

interface CompletionTransport {
  create(
    body: Record<string, unknown>,
    options: { signal?: AbortSignal },
  ): Promise<unknown>;
}

export class OpenAICompatibleLLMClient implements LLMClient {
  private readonly transport: CompletionTransport;

  constructor(
    private readonly options: OpenAICompatibleLLMClientOptions,
    transport?: CompletionTransport,
  ) {
    if (transport) {
      this.transport = transport;
      return;
    }

    const client = new OpenAI({
      baseURL: options.baseUrl,
      apiKey: options.apiKey,
      timeout: options.requestTimeoutMs,
      maxRetries: options.maxRetries ?? 1,
    });
    this.transport = {
      create: (body, requestOptions) =>
        client.chat.completions.create(
          body as never,
          requestOptions,
        ),
    };
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    request.signal?.throwIfAborted();
    try {
      const raw = await this.transport.create(
        {
          model: this.options.model,
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
        },
        { signal: request.signal },
      );
      request.signal?.throwIfAborted();
      return parseResponse(raw);
    } catch (error: unknown) {
      if (error instanceof LLMError) throw error;
      throw mapLLMError(error, request.signal);
    }
  }
}

function toOpenAIMessage(message: LLMMessage): Record<string, unknown> {
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

function parseResponse(raw: unknown): LLMResponse {
  if (!isRecord(raw) || !Array.isArray(raw.choices) || !raw.choices[0]) {
    throw new LLMError(
      "INVALID_RESPONSE",
      "LLM response does not contain choices[0].",
      raw,
    );
  }

  const choice = raw.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new LLMError(
      "INVALID_RESPONSE",
      "LLM response choice does not contain a message.",
      raw,
    );
  }
  const message = choice.message;
  const content =
    typeof message.content === "string" || message.content === null
      ? message.content
      : null;
  const reasoning =
    typeof message.reasoning === "string"
      ? message.reasoning
      : typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : undefined;
  const toolCalls = parseToolCalls(message.tool_calls);
  if (content === null && toolCalls.length === 0) {
    throw new LLMError(
      "INVALID_RESPONSE",
      "Assistant response contains neither text nor function tool calls.",
      raw,
    );
  }

  const usage = isRecord(raw.usage)
    ? {
        ...(numberOrUndefined(raw.usage.prompt_tokens) === undefined
          ? {}
          : { promptTokens: numberOrUndefined(raw.usage.prompt_tokens) }),
        ...(numberOrUndefined(raw.usage.completion_tokens) === undefined
          ? {}
          : {
              completionTokens: numberOrUndefined(
                raw.usage.completion_tokens,
              ),
            }),
        ...(numberOrUndefined(raw.usage.total_tokens) === undefined
          ? {}
          : { totalTokens: numberOrUndefined(raw.usage.total_tokens) }),
      }
    : undefined;

  return {
    message: {
      role: "assistant",
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    },
    ...(reasoning === undefined ? {} : { reasoning }),
    finishReason:
      typeof choice.finish_reason === "string"
        ? choice.finish_reason
        : null,
    ...(usage ? { usage } : {}),
  };
}

function parseToolCalls(value: unknown): LLMToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new LLMError(
      "INVALID_RESPONSE",
      "Assistant tool_calls is not an array.",
      value,
    );
  }

  const calls: LLMToolCall[] = [];
  for (const call of value) {
    if (!isRecord(call) || call.type !== "function") {
      throw new LLMError(
        "INVALID_RESPONSE",
        "Unsupported non-function tool call.",
        call,
      );
    }
    const fn = call.function;
    if (
      typeof call.id !== "string" ||
      !isRecord(fn) ||
      typeof fn.name !== "string" ||
      typeof fn.arguments !== "string"
    ) {
      throw new LLMError(
        "INVALID_RESPONSE",
        "Malformed function tool call.",
        call,
      );
    }
    calls.push({
      id: call.id,
      name: fn.name,
      arguments: fn.arguments,
    });
  }
  return calls;
}

function mapLLMError(
  error: unknown,
  signal: AbortSignal | undefined,
): LLMError {
  if (
    signal?.aborted ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return new LLMError("ABORTED", "LLM request was aborted.", error);
  }
  if (
    error instanceof Error &&
    (error.name.includes("Timeout") ||
      error.message.toLowerCase().includes("timed out"))
  ) {
    return new LLMError("TIMEOUT", "LLM request timed out.", error);
  }
  const status =
    isRecord(error) && typeof error.status === "number"
      ? error.status
      : undefined;
  if (
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    (error instanceof Error &&
      (error.name === "APIConnectionError" ||
        error.message.toLowerCase().includes("connect")))
  ) {
    return new LLMError("UNAVAILABLE", "LLM service is unavailable.", error);
  }
  return new LLMError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : String(error),
    error,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
