export type TraceSink = (event: string, data: unknown) => void;

let sink: TraceSink = () => undefined;

export function setTraceSink(nextSink: TraceSink): void {
  sink = nextSink;
}

export function writeTrace(event: string, data: unknown): void {
  sink(event, data);
}
