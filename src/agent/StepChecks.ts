import { PLAN_LIMITS } from "../config";

export interface StepCheck {
  readonly line: number;
  readonly item: string;
  readonly operator: ">=" | "==" | "<=";
  readonly expected: number;
}

/** Closed grammar, not an expression engine. Parsing never reads inventory or executes input. */
export function parseStepChecks(text: string, isKnownItem: (item: string) => boolean, step: number): StepCheck[] {
  const fail = (line: number, expression: string, reason: string): never => {
    throw new Error(`Invalid checks — step ${step}, line ${line}:\n${expression}\n${reason}\nExample: inventory_count(stick) >= 4\nPlan not accepted. Previous plan unchanged.`);
  };
  if (text.length > PLAN_LIMITS.checkChars) fail(1, "(field too long)", `Maximum ${PLAN_LIMITS.checkChars} characters.`);
  const checks: StepCheck[] = [];
  const bounds = new Map<string, { min: number; max: number }>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const expression = raw.trim();
    if (!expression) continue;
    const line = index + 1;
    if (checks.length >= PLAN_LIMITS.checkLines) fail(line, expression, `Maximum ${PLAN_LIMITS.checkLines} nonempty lines.`);
    const match = /^inventory_count[ \t]*\([ \t]*([a-z][a-z0-9_]*)[ \t]*\)[ \t]*(>=|==|<=)[ \t]*([0-9]+)$/.exec(expression);
    if (!match) {
      const name = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/.exec(expression)?.[1];
      fail(line, expression, name && name !== "inventory_count"
        ? `Unknown function "${name}". Allowed: inventory_count(item).`
        : "Use inventory_count(exact_item_name) followed by >=, == or <= and a non-negative decimal integer. No other text or operators allowed.");
    }
    const [, item, operator, number] = match!;
    if (!isKnownItem(item!)) fail(line, expression, `Unknown Minecraft item "${item}".`);
    const expected = Number(number);
    if (!Number.isSafeInteger(expected)) fail(line, expression, "Expected a non-negative safe integer.");
    const range = bounds.get(item!) ?? { min: 0, max: Number.MAX_SAFE_INTEGER };
    if (operator !== "<=") range.min = Math.max(range.min, expected);
    if (operator !== ">=") range.max = Math.min(range.max, expected);
    if (range.min > range.max) fail(line, expression, `Contradictory inventory bounds for ${item}.`);
    bounds.set(item!, range);
    checks.push({ line, item: item!, operator: operator as StepCheck["operator"], expected });
  }
  return checks;
}
