import { z } from "zod";

const EnvironmentSchema = z.object({
  LLM_BASE_URL: z.string().url().default("http://localhost:11434/v1"),
  LLM_API_KEY: z.string().min(1).default("ollama"),
  LLM_MODEL: z.string().min(1).default("qwen3.5:9b"),
  LLM_TEMPERATURE: numericEnvironment(0.2, 0, 2),
  LLM_REASONING_EFFORT: z
    .enum(["none", "low", "medium", "high", "max"])
    .default("medium"),
  LLM_MAX_TOKENS: integerEnvironment(4_096, 1),
  LLM_REQUEST_TIMEOUT_MS: integerEnvironment(120_000, 1),
  BOT_MODE: z.enum(["agent", "demo"]).default("agent"),
  LANDMARKS_FILE: z.string().min(1).default("./data/landmarks.json"),
  PROMPTS_DIR: z.string().min(1).default("./prompts"),
  AGENT_INSPECTOR_ENABLED: booleanEnvironment(true),
  AGENT_INSPECTOR_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  AGENT_INSPECTOR_PORT: integerEnvironment(3_001, 1, 65_535),
  AGENT_INSPECTOR_MAX_ROUNDS: integerEnvironment(30, 1, 1_000),
  AGENT_MEMORY_MAX_CHARS: integerEnvironment(500, 1, 100_000),
  AGENT_RESPONSE_MAX_RETRIES: integerEnvironment(8, 0, 32),
});

export interface AgentConfig {
  readonly llmBaseUrl: string;
  readonly llmApiKey: string;
  readonly llmModel: string;
  readonly llmTemperature: number;
  readonly llmReasoningEffort: "none" | "low" | "medium" | "high" | "max";
  readonly llmMaxTokens: number;
  readonly llmRequestTimeoutMs: number;
  readonly botMode: "agent" | "demo";
  readonly landmarksFile: string;
  readonly promptsDirectory: string;
  readonly inspectorEnabled: boolean;
  readonly inspectorHost: "127.0.0.1";
  readonly inspectorPort: number;
  readonly inspectorMaxRounds: number;
  readonly memoryMaxChars: number;
  readonly responseMaxRetries: number;
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
    llmReasoningEffort: parsed.LLM_REASONING_EFFORT,
    llmMaxTokens: parsed.LLM_MAX_TOKENS,
    llmRequestTimeoutMs: parsed.LLM_REQUEST_TIMEOUT_MS,
    botMode: parsed.BOT_MODE,
    landmarksFile: parsed.LANDMARKS_FILE,
    promptsDirectory: parsed.PROMPTS_DIR,
    inspectorEnabled: parsed.AGENT_INSPECTOR_ENABLED,
    inspectorHost: parsed.AGENT_INSPECTOR_HOST,
    inspectorPort: parsed.AGENT_INSPECTOR_PORT,
    inspectorMaxRounds: parsed.AGENT_INSPECTOR_MAX_ROUNDS,
    memoryMaxChars: parsed.AGENT_MEMORY_MAX_CHARS,
    responseMaxRetries: parsed.AGENT_RESPONSE_MAX_RETRIES,
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

function booleanEnvironment(
  defaultValue: boolean,
): z.ZodType<boolean, z.ZodTypeDef, unknown> {
  return z.preprocess((value) => {
    if (value === undefined || value === "") return defaultValue;
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
    return value;
  }, z.boolean());
}
