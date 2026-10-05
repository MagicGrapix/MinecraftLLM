import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blueprint } from "../../src/building/Blueprint";

/** Return a fresh copy; tests must never modify a shared drawing. */
export async function blueprintFixture(withDoor = false): Promise<Blueprint> {
  return JSON.parse(await readFile(join(__dirname, "../fixtures/blueprints",
    withDoor ? "small-oak-house.json" : "small-oak-shelter.json"), "utf8")) as Blueprint;
}
