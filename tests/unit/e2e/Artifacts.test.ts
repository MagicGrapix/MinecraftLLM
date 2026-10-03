import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishTrial, recorder, writeCampaignReport } from "../../e2e/Artifacts";

test("saved reports survive process exit and a truncated final JSONL line", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-scenario-report-"));
  try {
    const trial = join(root, "001_craft_table"); await mkdir(trial);
    const record = recorder(join(trial, "events.jsonl"));
    record("tool.started", { actionNumber: 1, tool: "craft", context: { agent: "actioner" } });
    record("tool.completed", { actionNumber: 1, tool: "craft", ok: true });
    await writeFile(join(trial, "trace_partial.jsonl"), '{"event":');
    const result = await finishTrial(root, trial, { scenario: "craft_table", status: "timeout", startedAt: new Date().toISOString(), durationMs: 300_000, timeoutMs: 300_000, goalReachedAtMs: 10_000 });
    assert.equal(result.statistics.toolCalls, 1);
    await writeCampaignReport(root, [result]);
    assert.equal(JSON.parse(await readFile(join(trial, "result.json"), "utf8")).status, "timeout");
    assert.match(await readFile(join(root, "report.html"), "utf8"), /craft_table/);
    assert.equal(JSON.parse(await readFile(join(root, "results.json"), "utf8")).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
