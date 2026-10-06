import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentProcess } from "../../e2e/AgentProcess";
import { loadWorldBuilderConfig } from "../../../src/devworld/WorldBuilderConfig";

test("fresh child processes reset state and IPC reports acceptance; owned stuck child is terminated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minecraft-scenario-ipc-"));
  const stub = resolve("tests/support/ScenarioWorkerStub.ts");
  const sessions: string[] = [];
  let child: AgentProcess | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const path = join(directory, String(i)); await mkdir(path);
      child = new AgentProcess(loadWorldBuilderConfig({}), path, "unused", () => undefined, stub);
      await child.waitReady(15_000);
      sessions.push(child.sessionId!);
      assert.equal((await child.snapshot()).inventory.oak_log, 0);
      const positions = [{ x: 0, y: -60, z: 1 }];
      assert.deepEqual((await child.snapshot(positions)).blocks, [{ position: positions[0], name: "air" }]);
      assert.equal(child.acceptedAt, null);
      await child.arm("Collect wood.");
      assert.equal((await child.snapshot()).inventory.oak_log, 2);
      assert.notEqual(child.acceptedAt, null);
      await child.settle(500);
      assert.equal((await child.snapshot()).inventory.oak_log, 2, "Settlement keeps the client available for final observation.");
      assert.equal(await child.close(500), false);
      child = undefined;
    }
    assert.notEqual(sessions[0], sessions[1]);
    const path = join(directory, "stuck"); await mkdir(path);
    const events: string[] = [];
    child = new AgentProcess({ ...loadWorldBuilderConfig({}), agentUsername: "stuck" }, path, "unused", (event) => events.push(event), stub);
    await child.waitReady(15_000);
    assert.equal(await child.close(10), true);
    assert.ok(events.includes("process.force_stop"));
    child = undefined;
  } finally {
    await child?.close(10);
    await rm(directory, { recursive: true, force: true });
  }
});
