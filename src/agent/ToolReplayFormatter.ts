import { stringify } from "yaml";
import type { LLMMessage } from "../llm/LLMClient";
import { promptNumbers } from "./PromptNumberFormatter";

/** Presentation only: execution and debug traces keep the original calls/results. */
export function compactToolExchange(
  message: Extract<LLMMessage, { role: "assistant" }>,
  results: readonly Extract<LLMMessage, { role: "tool" }>[],
): Extract<LLMMessage, { role: "assistant" }> {
  const calls = message.toolCalls!;
  const records = calls.map((call, index) => ({
    tool: call.name,
    arguments: promptNumbers(parseData(call.arguments)),
    result: parseData(results[index]!.content),
  }));
  const only = records.length === 1 ? records[0] : undefined;
  // Only an acknowledged reply is player-facing speech. Failed attempts stay records.
  if (only?.tool === "reply" && isRecord(only.arguments) && typeof only.arguments.message === "string" &&
    isRecord(only.result) && only.result.ok === true && isRecord(only.result.value) && only.result.value.sent === true) {
    return { role: "assistant", content: only.arguments.message };
  }
  const data = records.map(({ arguments: args, ...record }) => ({
    tool: record.tool,
    ...(isRecord(args) && Object.keys(args).length === 0 ? {} : { arguments: args }),
    result: record.result,
  }));
  const text = stringify(data.length === 1 ? data[0] : data, { lineWidth: 0 }).trimEnd();
  return {
    role: "assistant",
    content: `Tool activity (application record, not a player message):\n${
      message.content ? `Assistant note:\n${message.content}\n\n` : ""
    }${text}`,
  };
}

function parseData(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
