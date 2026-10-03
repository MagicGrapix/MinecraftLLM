export type TraceSink = (event: string, data: unknown) => void;
export const SESSION_ID = `${Date.now()}_${process.pid}`;

let sink: TraceSink = () => undefined;
const observers = new Set<TraceSink>();

/** Optional local observers; normal file logging always remains installed. */
export function subscribeTrace(observer: TraceSink): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

export function setTraceSink(nextSink: TraceSink): void {
  sink = nextSink;
}

export function writeTrace(event: string, data: unknown): void {
  sink(event, data);
  for (const observer of observers) {
    try { observer(event, data); } catch { /* Telemetry must not alter execution. */ }
  }
}
