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
    record("tool.started", { actionNumber: 1, tool: "craft_from_inventory_2x2", context: { agent: "actioner" } });
    record("tool.completed", { actionNumber: 1, tool: "craft_from_inventory_2x2", ok: true });
    await writeFile(join(trial, "trace_partial.jsonl"), '{"event":');
    await mkdir(join(trial, "blueprints"));
    const blueprintFile = "bp_00000000-0000-0000-0000-000000000001.json";
    await writeFile(join(trial, "blueprints", blueprintFile), '{"blueprint":{"name":"test"}}');
    const result = await finishTrial(root, trial, { scenario: "craft_table", status: "timeout", startedAt: new Date().toISOString(), durationMs: 300_000, timeoutMs: 300_000, goalReachedAtMs: 10_000 });
    assert.equal(result.statistics.toolCalls, 1);
    assert.ok(result.files?.includes(`blueprints/${blueprintFile}`));
    await writeCampaignReport(root, [result]);
    assert.equal(JSON.parse(await readFile(join(trial, "result.json"), "utf8")).status, "timeout");
    assert.match(await readFile(join(root, "report.html"), "utf8"), /craft_table/);
    assert.match(await readFile(join(root, "report.html"), "utf8"), /Independent final verification/);
    assert.equal(JSON.parse(await readFile(join(root, "results.json"), "utf8")).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
