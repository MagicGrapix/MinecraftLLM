import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { ContainerSessionManager } from "../../../src/runtime/ContainerSessionManager";
import { createCapabilityRegistry } from "../../../src/bootstrap/createCapabilities";

test("bootstrap exposes every capability with an actionable description", () => {
  const registry = createCapabilityRegistry(
    new ContainerSessionManager({} as Bot),
  );
  const summaries = registry.list();

  assert.equal(summaries.length, 14);
  assert.equal(
    summaries.every(
      (summary) =>
        summary.description.length > 20 &&
        registry.has(summary.name) &&
        registry.get(summary.name)?.inputSchema !== undefined,
    ),
    true,
  );
});
