import { z } from "zod";

const EnvironmentSchema = z.object({
  LLM_BASE_URL: z.string().url().default("http://localhost:11434/v1"),
  LLM_API_KEY: z.string().min(1).default("ollama"),
  LLM_MODEL: z.string().min(1).default("qwen3.5:9b"),
  LLM_TEMPERATURE: numericEnvironment(0.2, 0, 2),
  LLM_MAX_TOKENS: integerEnvironment(1_200, 1),
  LLM_REQUEST_TIMEOUT_MS: integerEnvironment(120_000, 1),
  LLM_MAX_TOOL_ROUNDS: integerEnvironment(8, 1, 32),
  LLM_CONTEXT_BUDGET_CHARS: integerEnvironment(30_000, 4_000),
  BOT_OWNER_USERNAME: z.string().min(1).default("GrapixMagique"),
  BOT_MODE: z.enum(["agent", "demo"]).default("agent"),
  LANDMARKS_FILE: z.string().min(1).default("./data/landmarks.json"),
});

export interface AgentConfig {
  readonly llmBaseUrl: string;
  readonly llmApiKey: string;
  readonly llmModel: string;
  readonly llmTemperature: number;
  readonly llmMaxTokens: number;
  readonly llmRequestTimeoutMs: number;
  readonly llmMaxToolRounds: number;
  readonly llmContextBudgetChars: number;
  readonly botOwnerUsername: string;
  readonly botMode: "agent" | "demo";
  readonly landmarksFile: string;
}

export function loadAgentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const parsed = EnvironmentSchema.parse(environment);
  return {
    llmBaseUrl: parsed.LLM_BASE_URL,
    llmApiKey: parsed.LLM_API_KEY,
    llmModel: parsed.LLM_MODEL,
    llmTemperature: parsed.LLM_TEMPERATURE,
    llmMaxTokens: parsed.LLM_MAX_TOKENS,
    llmRequestTimeoutMs: parsed.LLM_REQUEST_TIMEOUT_MS,
    llmMaxToolRounds: parsed.LLM_MAX_TOOL_ROUNDS,
    llmContextBudgetChars: parsed.LLM_CONTEXT_BUDGET_CHARS,
    botOwnerUsername: parsed.BOT_OWNER_USERNAME,
    botMode: parsed.BOT_MODE,
    landmarksFile: parsed.LANDMARKS_FILE,
  };
}

function numericEnvironment(
  defaultValue: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): z.ZodType<number, z.ZodTypeDef, unknown> {
  return z.preprocess(
    (value) =>
      value === undefined || value === "" ? defaultValue : Number(value),
    z.number().finite().min(minimum).max(maximum),
  );
}

function integerEnvironment(
  defaultValue: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): z.ZodType<number, z.ZodTypeDef, unknown> {
  return z.preprocess(
    (value) =>
      value === undefined || value === "" ? defaultValue : Number(value),
    z.number().int().min(minimum).max(maximum),
  );
}
