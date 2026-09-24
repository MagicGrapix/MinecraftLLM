import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from "./LLMClient";

export type FakeLLMHandler = (
  request: LLMRequest,
) => LLMResponse | Promise<LLMResponse>;

export class FakeLLMClient implements LLMClient {
  readonly requests: LLMRequest[] = [];
  private readonly handlers: FakeLLMHandler[] = [];
  private activeRequests = 0;
  maxConcurrentRequests = 0;

  enqueue(response: LLMResponse | FakeLLMHandler): void {
    this.handlers.push(
      typeof response === "function" ? response : () => response,
    );
  }

  enqueueDeferred(
    options: { ignoreAbort?: boolean } = {},
  ): DeferredLLMResponse {
    const deferred = new DeferredLLMResponse();
    this.enqueue(async (request) => {
      if (options.ignoreAbort) return deferred.promise;
      return awaitAbortable(deferred.promise, request.signal);
    });
    return deferred;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const handler = this.handlers.shift();
    if (!handler) throw new Error("FakeLLMClient has no queued response.");

    this.requests.push(cloneRequest(request));
    this.activeRequests += 1;
    this.maxConcurrentRequests = Math.max(
      this.maxConcurrentRequests,
      this.activeRequests,
    );
    try {
      request.signal?.throwIfAborted();
      return await handler(request);
    } finally {
      this.activeRequests -= 1;
    }
  }
}

export class DeferredLLMResponse {
  readonly promise: Promise<LLMResponse>;
  private resolvePromise!: (response: LLMResponse) => void;
  private rejectPromise!: (error: unknown) => void;

  constructor() {
    this.promise = new Promise<LLMResponse>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  resolve(response: LLMResponse): void {
    this.resolvePromise(response);
  }

  reject(error: unknown): void {
    this.rejectPromise(error);
  }
}

function cloneRequest(request: LLMRequest): LLMRequest {
  return {
    messages: structuredClone(request.messages),
    ...(request.tools ? { tools: structuredClone(request.tools) } : {}),
    ...(request.responseFormat
      ? { responseFormat: request.responseFormat }
      : {}),
    ...(request.reasoningEffort
      ? { reasoningEffort: request.reasoningEffort }
      : {}),
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.maxTokens === undefined
      ? {}
      : { maxTokens: request.maxTokens }),
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.trace ? { trace: structuredClone(request.trace) } : {}),
  };
}

function awaitAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}
