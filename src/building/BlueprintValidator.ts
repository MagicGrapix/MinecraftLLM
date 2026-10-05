import { failure, success, type TaskResult } from "../execution/TaskResult";
import { normalizeMinecraftName } from "../shared/helper";
import { MaterialCatalog } from "../world/MaterialCatalog";
import { BlueprintSchema, type BlueprintCell, type BlueprintIssue, type BlueprintPlacement, type CompiledBlueprint } from "./Blueprint";
import { BLUEPRINT_LIMITS, BLUEPRINT_SOLID_BLOCKS } from "./BuildingConfig";

/** No bot dependency and no side effects: this class only validates and compiles a drawing. */
export class BlueprintValidator {
  private readonly supported = new Set(BLUEPRINT_SOLID_BLOCKS);

  constructor(readonly catalog: MaterialCatalog) {}

  validate(raw: unknown): TaskResult<CompiledBlueprint> {
    const parsed = BlueprintSchema.safeParse(raw);
    if (!parsed.success) {
      return invalid(parsed.error.issues.map((issue) => ({
        code: "INVALID_SHAPE", path: boundedText(issue.path.join(".") || "$", 200),
        message: boundedText(issue.message, 240),
        received: receivedAt(raw, issue.path),
      })));
    }
    // Zod returns a new object: namespace normalization never changes the submitted object.
    const blueprint = parsed.data;
    const issues: BlueprintIssue[] = [];
    const cells: BlueprintCell[] = [];
    const operations: BlueprintPlacement[] = [];
    const counts = new Map<string, number>();
    for (const [symbol, name] of Object.entries(blueprint.palette)) {
      const match = this.catalog.resolve("block", name);
      if (!match) {
        issues.push({ code: "UNKNOWN_BLOCK", path: `palette.${symbol}`, received: name,
          message: "Use an exact block ID from this Minecraft version; no substitution was made.",
          suggestions: this.catalog.search(name).suggestions.map((candidate) => candidate.name) });
        continue;
      }
      blueprint.palette[symbol] = match.name;
      if (!this.supported.has(match.name) || !this.catalog.isFullBlock(match.name)) {
        issues.push({ code: "UNSUPPORTED_BLOCK", path: `palette.${symbol}`, received: name,
          message: "This block exists but is not in the supported plain-cube blueprint set." });
      } else if (!this.catalog.resolve("item", match.name)) {
        issues.push({ code: "MISSING_PLACEMENT_ITEM", path: `palette.${symbol}`, received: name,
          message: "This version has no matching inventory item for placement." });
      }
    }
    blueprint.dependencies.doors.forEach((door, index) => {
      door.item = normalizeMinecraftName(door.item);
      issues.push({ code: "UNSUPPORTED_DEPENDENCY", path: `dependencies.doors.${index}`,
        received: door.item, position: door.position,
        message: "Door dependencies are reserved in the format but not supported yet (lot 3). No blueprint was accepted." });
    });
    blueprint.layers.forEach((layer, y) => {
      if (layer.length !== blueprint.depth) issues.push({
        code: "INVALID_SHAPE", path: `layers.${y}`, received: layer.length,
        message: `Expected ${blueprint.depth} rows (Z), received ${layer.length}.`,
      });
      layer.forEach((row, z) => {
        if (row.length !== blueprint.width) issues.push({
          code: "INVALID_SHAPE", path: `layers.${y}.${z}`, received: row.length,
          message: `Expected ${blueprint.width} characters (X), received ${row.length}.`,
        });
        [...row].forEach((symbol, x) => {
          const position = { x, y, z };
          if (symbol === "." || symbol === "_") {
            cells.push({ position, kind: symbol === "." ? "air" : "ignore" });
          } else if (!Object.hasOwn(blueprint.palette, symbol)) {
            issues.push({ code: "UNKNOWN_SYMBOL", path: `layers.${y}.${z}.${x}`, position, received: symbol,
              message: `Symbol "${symbol}" has no palette entry.` });
          } else {
            const block = blueprint.palette[symbol]!;
            cells.push({ position, kind: "block", block });
            operations.push({ kind: "place_block", position: { ...position }, block, item: block });
            counts.set(block, (counts.get(block) ?? 0) + 1);
          }
        });
      });
    });
    if (issues.length === 0 && operations.length === 0 && blueprint.dependencies.doors.length === 0) {
      issues.push({ code: "EMPTY_BLUEPRINT", path: "layers", message: "A blueprint must contain at least one block to place." });
    }
    if (issues.length) return invalid(issues);
    return success({ blueprint, minecraftVersion: this.catalog.minecraftVersion, height: blueprint.layers.length,
      cells, operations, materials: [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([item, quantity]) => ({ item, quantity })) });
  }
}

function invalid(issues: readonly BlueprintIssue[]): TaskResult<never> {
  return failure("INVALID_ARGUMENT", "Blueprint rejected; no world changes or substitutions were made.", {
    facts: { reason: "INVALID_BLUEPRINT", totalIssues: issues.length, issues: issues.slice(0, BLUEPRINT_LIMITS.maxIssues) },
  });
}

/** Error feedback is bounded even when a caller submits an oversized value. */
function receivedAt(raw: unknown, path: readonly (string | number)[]): unknown {
  let value = raw;
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  if (typeof value === "string") return boundedText(value, 160);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value !== null && typeof value === "object") return "object";
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") return typeof value;
  return value;
}

function boundedText(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) + "…" : value;
}
