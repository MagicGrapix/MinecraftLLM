import assert from "node:assert/strict";
import test from "node:test";
import type { Window } from "prismarine-windows";
import { ServerWindowObservation } from "../../../src/runtime/ServerWindowObservation";
import { stationBot, stationTiming } from "../../support/StationBot";

test("station evidence ignores local predictions and unrelated packets; early server contents are preserved", async () => {
  const f = stationBot(), observation = new ServerWindowObservation(f.bot, stationTiming);
  try {
    f.contents[0] = { item: "oak_log", count: 2 };
    f.emit();
    const window = f.window as unknown as Window;
    observation.bind(window); f.bot.currentWindow = window;
    f.client.emit("window_items", { windowId: 99, items: [], carriedItem: { itemCount: 0 } });
    window.slots.fill(null);
    assert.deepEqual(observation.snapshot()?.slots[0], { item: "oak_log", count: 2 });
    const copy = observation.snapshot()!;
    copy.slots[0]!.count = 50;
    assert.equal(observation.snapshot()?.slots[0]?.count, 2);
    f.client.emit("set_slot", { windowId: 7, slot: 0, item: { itemCount: 0 } });
    assert.equal(observation.snapshot()?.slots[0], null);
    f.client.emit("craft_progress_bar", { windowId: 7, property: 0, value: 42 });
    assert.equal(observation.snapshot()?.properties[0], 42);
    f.options.suppressSync = true;
    assert.equal(await observation.synchronize(f.abort.signal), false, "Old contents are not a fresh resynchronization.");
    f.options.suppressSync = false;
    assert.equal(await observation.synchronize(f.abort.signal), true);
  } finally { observation.dispose(); }
  for (const event of ["window_items", "set_slot", "set_cursor_item", "craft_progress_bar"]) assert.equal(f.client.listenerCount(event), 0);
});

test("unknown/malformed station contents are not empty and packet listeners do not throw", () => {
  const f = stationBot(), observation = new ServerWindowObservation(f.bot);
  try {
    observation.bind(f.window as unknown as Window);
    assert.equal(observation.snapshot(), null);
    assert.doesNotThrow(() => f.client.emit("window_items",
      { windowId: 7, items: [{ itemCount: 1, itemId: -1 }], carriedItem: { itemCount: 0 } }));
    assert.throws(() => observation.snapshot(), /Invalid server station contents/);
  } finally { observation.dispose(); }
});

test("replacement or aborted windows cannot be resynchronized", async () => {
  const f = stationBot(), observation = new ServerWindowObservation(f.bot);
  try {
    observation.bind(f.window as unknown as Window);
    await assert.rejects(observation.synchronize(f.abort.signal), /no longer available/);
    f.bot.currentWindow = f.window as unknown as Window;
    f.abort.abort();
    await assert.rejects(observation.synchronize(f.abort.signal));
    assert.equal(f.calls.length, 0);
  } finally { observation.dispose(); }
});
