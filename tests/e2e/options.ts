import { scenarioConfig } from "./config";

export interface CampaignOptions {
  scenario?: string;
  timeoutMs?: number;
  repetitions: number;
  campaigns: number;
  intervalMs: number;
  list: boolean;
  help: boolean;
}
export function parseOptions(args: readonly string[]): CampaignOptions {
  const options: CampaignOptions = { repetitions: scenarioConfig.repetitions, campaigns: scenarioConfig.campaigns, intervalMs: scenarioConfig.intervalMs, list: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--list") { options.list = true; continue; }
    if (arg === "--help") { options.help = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--scenario") { options.scenario = value; continue; }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > 86_400) throw new Error(`Invalid value for ${arg}: ${value}`);
    if (arg === "--timeout") options.timeoutMs = number * 1_000;
    else if (arg === "--repeat") options.repetitions = number;
    else if (arg === "--campaigns") options.campaigns = number;
    else if (arg === "--interval") options.intervalMs = number * 1_000;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}
