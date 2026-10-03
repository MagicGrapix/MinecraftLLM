import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/** Use the actual schema as the correction source, not a second hand-written contract. */
export function invalidToolArguments(name: string, raw: unknown, issues: readonly z.ZodIssue[], schema: z.ZodTypeAny): string {
  const jsonSchema = zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>;
  const details = issues.slice(0, 6).map((issue) => {
    let value: unknown = raw;
    let expected: unknown = jsonSchema;
    for (const key of issue.path) {
      value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
      expected = propertySchema(expected, key);
    }
    return `Field ${issue.path.join(".") || "input"}: ${issue.message}. Received: ${display(value)}. Expected schema: ${display(expected)}.`;
  });
  return `Invalid arguments for "${name}". ${details.join(" ")}${typeof jsonSchema.description === "string" ? ` Input guide: ${jsonSchema.description}.` : ""} No tool was executed; no movement or game action occurred. Correct the rejected fields and call the tool again. Examples in descriptions illustrate format, not observed targets.`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function propertySchema(schema: unknown, key: string | number): unknown {
  const node = record(schema);
  const direct = typeof key === "number" ? node.items : record(node.properties)[key];
  if (direct !== undefined) return direct;
  const variants = node.oneOf ?? node.anyOf ?? node.allOf;
  if (!Array.isArray(variants)) return undefined;
  const matches = variants.map((variant) => propertySchema(variant, key)).filter((match) => match !== undefined);
  return matches.length === 1 ? matches[0] : matches.length ? { anyOf: matches } : undefined;
}

export function parseToolArguments(name: string, raw: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`Invalid arguments for "${name}": expected a JSON object. Received: ${display(raw)}. No tool was executed.`); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid arguments for "${name}": expected a JSON object, not an array or string. Received: ${display(parsed)}. No tool was executed.`);
  }
  return parsed as Record<string, unknown>;
}

function display(value: unknown): string {
  const text = value === undefined ? "missing" : JSON.stringify(value);
  return text.length > 1600 ? `${text.slice(0, 1600)}…` : text;
}
