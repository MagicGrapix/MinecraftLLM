/** Presentation only: do not use these values to replace runtime state. */
export function promptNumber(value: number): number {
  return Number(value.toFixed(2));
}

export function promptNumbers(value: unknown): unknown {
  if (typeof value === "number") return promptNumber(value);
  if (Array.isArray(value)) return value.map(promptNumbers);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, promptNumbers(field)]));
  }
  return value;
}
