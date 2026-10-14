import { errorMessage } from "../shared/helper";

/** One local sequence for the collector and all its physical sub-operations. */
export class CollectionTrace {
  private sequence = 0;
  constructor(readonly emit: (event: Record<string, unknown>) => void = () => {}) {}
  async run<T>(operation: string, args: unknown, run: () => Promise<T>): Promise<T> {
    const index = ++this.sequence, started = performance.now();
    this.emit({ event: "operation_started", index, operation, args });
    try {
      const result = await run();
      this.emit({ event: "operation_finished", index, operation, durationMs: Math.round(performance.now() - started), result });
      return result;
    } catch (error) {
      this.emit({ event: "operation_failed", index, operation, durationMs: Math.round(performance.now() - started), error: errorMessage(error) });
      throw error;
    }
  }
}
