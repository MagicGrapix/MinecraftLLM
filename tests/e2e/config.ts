/** Campaign defaults. No additional environment variables are needed to edit these. */
export const scenarioConfig = {
  botUsername: "test_bot",
  controllerUsername: "test_controller",
  timeoutMs: 300_000,
  startupTimeoutMs: 45_000,
  acceptanceTimeoutMs: 10_000,
  stopGraceMs: 10_000,
  pollMs: 200,
  repetitions: 1,
  campaigns: 1,
  intervalMs: 0,
  outputDirectory: "logs/scenarios",
} as const;
