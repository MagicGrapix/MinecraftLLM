import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { setTraceSink, SESSION_ID } from "./TraceLog";

type ConsoleMethod = "log" | "warn" | "error" | "info" | "debug";

// Flag to control the debug output
let debugEnabled = true;
let fileLoggingFailed = false;
const fullTraceEnabled =
  process.env.LOG_FULL_TRACE?.trim().toLowerCase() !== "false";
const logDirectory = resolve(process.cwd(), process.env.LOG_DIR ?? "./logs");
const runId = SESSION_ID;
const logFilePath = resolve(logDirectory, `log_${runId}.log`);
const fullTraceFilePath = fullTraceEnabled
  ? resolve(logDirectory, `trace_${runId}.jsonl`)
  : null;

try {
  mkdirSync(logDirectory, { recursive: true });
  appendReadable(
    `[session] started pid=${process.pid} cwd=${oneLine(process.cwd())}`,
  );
  appendFullTrace("session.started", {
    pid: process.pid,
    cwd: process.cwd(),
    argv: process.argv,
  });
} catch (error: unknown) {
  fileLoggingFailed = true;
  process.stderr.write(
    `Could not initialize file logging at ${logFilePath}: ${String(error)}\n`,
  );
}

setTraceSink((event, data) => {
  appendFullTrace(event, data);
  appendReadableTrace(event, data);
});

export function getLogFilePath(): string | null {
  return fileLoggingFailed ? null : logFilePath;
}

export function getFullTraceFilePath(): string | null {
  return fileLoggingFailed ? null : fullTraceFilePath;
}

// Function to enable or disable debug messages
export const setDebugEnabled = (enabled: boolean) => {
  debugEnabled = enabled;
};

// Function to wrap console methods with color and log level prefix
const wrapConsoleMethod = (method: ConsoleMethod, color: string): void => {
  const originalMethod = console[method].bind(console);

  console[method] = (...args: unknown[]) => {
    // For debug method, respect the debugEnabled flag
    if (method === 'debug' && !debugEnabled) return;

    const now = new Date();
    const time = now.toTimeString().split(' ')[0];
    const prefix = `\x1b[${color}m[${method}:${time}]\x1b[0m`;

    originalMethod(prefix, ...args);
    appendReadable(
      `[${method}] ${args.map(formatReadableValue).join(" ")}`,
      now,
    );
    appendFullTrace("console", {
      level: method,
      arguments: args.map(normalizeLogValue),
    });
  };
};

// ANSI color codes for terminal
const COLORS = {
  white: "37",
  yellow: "33",
  red: "31",
  green: "32",
  orange: "35",
};

// Wrap standard methods with specific colors
wrapConsoleMethod("log", COLORS.white);
wrapConsoleMethod("warn", COLORS.yellow);
wrapConsoleMethod("error", COLORS.red);

// Wrap custom methods with specific colors
wrapConsoleMethod("info", COLORS.green);
wrapConsoleMethod("debug", COLORS.orange);

function appendReadableTrace(event: string, data: unknown): void {
  if (event !== "agent.llm.response" || !isRecord(data)) return;
  const response = isRecord(data.response) ? data.response : null;
  const reasoning = response?.reasoning;
  if (typeof reasoning !== "string" || reasoning.trim() === "") return;

  appendReadable(
    `[reasoning] generation=${String(data.generationId)} round=${String(data.round)} ${truncate(oneLine(reasoning), 1_200)}`,
  );
}

function appendReadable(message: string, now = new Date()): void {
  if (fileLoggingFailed) return;
  try {
    appendFileSync(logFilePath, `${now.toISOString()} ${message}\n`, "utf8");
  } catch (error: unknown) {
    failFileLogging(error);
  }
}

function appendFullTrace(event: string, data: unknown): void {
  if (fileLoggingFailed || fullTraceFilePath === null) return;
  try {
    appendFileSync(
      fullTraceFilePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        data: normalizeLogValue(data),
      })}\n`,
      "utf8",
    );
  } catch (error: unknown) {
    failFileLogging(error);
  }
}

function failFileLogging(error: unknown): void {
  fileLoggingFailed = true;
  process.stderr.write(`File logging failed: ${String(error)}\n`);
}

function formatReadableValue(value: unknown): string {
  if (typeof value === "string") return oneLine(value);
  return oneLine(
    inspect(value, {
      depth: 6,
      breakLength: Number.POSITIVE_INFINITY,
      compact: true,
      maxArrayLength: 50,
      maxStringLength: 1_200,
    }),
  );
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}…`;
}

function normalizeLogValue(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, current: unknown) => {
        if (typeof current === "bigint") return current.toString();
        if (current instanceof Error) {
          return {
            name: current.name,
            message: current.message,
            stack: current.stack,
          };
        }
        return current;
      }),
    );
  } catch {
    return inspect(value, { depth: 10, maxArrayLength: 500 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
