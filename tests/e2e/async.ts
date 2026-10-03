import { setTimeout as delay } from "node:timers/promises";

export async function bounded<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export async function until(check: () => boolean | Promise<boolean>, ms: number, label: string, signal?: AbortSignal, timeoutDetails?: () => string): Promise<void> {
  const deadline = performance.now() + ms;
  while (true) {
    signal?.throwIfAborted();
    if (await check()) return;
    if (performance.now() >= deadline) {
      const details = timeoutDetails?.();
      throw new Error(`${label} timed out after ${ms} ms${details ? `. ${details}` : ""}`);
    }
    await delay(50, undefined, { signal });
  }
}

export function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
