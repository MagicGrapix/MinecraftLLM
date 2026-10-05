/** Attempt every release, in order, even if an earlier one fails or hangs. */
export async function cleanupSteps(
  steps: readonly { name: string; run(): unknown | Promise<unknown> }[],
  timeoutMs = 10_000,
): Promise<void> {
  const errors: Error[] = [];
  for (const step of steps) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => step.run()),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Cleanup timed out after ${timeoutMs} ms.`)), timeoutMs);
        }),
      ]);
    } catch (cause) {
      errors.push(new Error(`Cleanup failed: ${step.name}`, { cause }));
    } finally { clearTimeout(timer); }
  }
  if (errors.length) throw new AggregateError(errors, "Runtime cleanup was incomplete; all release steps were attempted.");
}
