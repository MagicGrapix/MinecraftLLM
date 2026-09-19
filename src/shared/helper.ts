import { isAbsolute, relative, resolve } from "node:path";

export class ExecutionCancelledError extends Error {
  constructor() {
    super("Execution cancelled.");
    this.name = "ExecutionCancelledError";
  }
}

export async function runWithCancellation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  if (signal.aborted) {
    throw new ExecutionCancelledError();
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", handleAbort);
    };

    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const handleAbort = (): void => {
      settle(() => reject(new ExecutionCancelledError()));
    };

    const timer = setTimeout(() => {
      onTimeout();
      if (!signal.aborted) {
        settle(() => reject(new ExecutionCancelledError()));
      }
    }, timeoutMs);

    signal.addEventListener("abort", handleAbort, { once: true });
    operation.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeMinecraftName(name: string): string {
  return name.startsWith("minecraft:") ? name.slice("minecraft:".length) : name;
}

export function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(relativePath)
  );
}
