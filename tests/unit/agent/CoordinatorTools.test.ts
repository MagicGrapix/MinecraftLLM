import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { CoordinatorTools } from "../../../src/agent/CoordinatorTools";
import { WorldQueryRegistry } from "../../../src/world/queries/WorldQueryRegistry";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import { CapabilityRegistry } from "../../../src/capabilities/CapabilityRegistry";

test("world queries cannot shadow coordinator workflow tools", () => {
  for (const name of ["reply", "ask_planner", "run_step", "evaluate_step", "complete_step", "refresh_summary"]) {
    const queries = new WorldQueryRegistry({} as WorldQueries);
    queries.register({ name, description: "collision", inputSchema: z.object({}), execute: async () => ({ ok: true, value: null }) });
    assert.throws(() => new CoordinatorTools(queries), /Duplicate coordinator tool/);
  }
});

test("run_step accepts only an index; planner/architect instructions remain available", () => {
  const tools = new CoordinatorTools(new WorldQueryRegistry({} as WorldQueries));
  const call = (name: string, args: unknown) => tools.parse({ id: "1", name, arguments: JSON.stringify(args) });
  assert.deepEqual(call("run_step", { step: 1 }), { name: "run_step", input: { step: 1 } });
  assert.throws(() => call("run_step", { step: 1, instruction: "Use a wrong recipe" }), /instruction/);
  assert.equal(call("ask_planner", { instruction: "Plan" }).name, "ask_planner");
  assert.equal(call("ask_architect", { instruction: "Design" }).name, "ask_architect");
  assert.ok(!tools.catalog().some(t => t.name === "inventory_count"));
});

test("registries reject late additions after runtime catalog assembly", () => {
  const queries = new WorldQueryRegistry({} as WorldQueries), capabilities = new CapabilityRegistry();
  queries.freeze(); capabilities.freeze();
  assert.throws(() => queries.register({ name: "late", description: "late", inputSchema: z.object({}), execute: async () => ({ ok: true, value: null }) }), /frozen/);
  assert.throws(() => capabilities.register({ name: "late", inputSchema: z.object({}), execute: async () => ({ ok: true, value: null }) }), /frozen/);
});
