import type { Recipe, RecipeItem } from "prismarine-recipe";
import { z } from "zod";
import { ACTION_CONFIRMATION } from "../config";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { snapshotInventory } from "../runtime/InventoryAdapter";
import { toVec3 } from "../runtime/PositionAdapter";
import { errorMessage, normalizeMinecraftName } from "../shared/helper";
import { BlockPositionSchema } from "../shared/types";
import type { Capability, ExecutionContext } from "./Capability";
import { hasEmptyCraftingArea, InventoryObservationError, ServerInventoryConfirmation } from "../runtime/ServerInventoryConfirmation";
import type { ConfirmationTiming } from "../runtime/waitForConfirmation";
import { writeTrace } from "../TraceLog";

const MAX_CRAFT_OUTPUT_QUANTITY = 64;

const CraftQuantitySchema = z.number().int().positive().max(MAX_CRAFT_OUTPUT_QUANTITY)
  .describe("Minimum output item quantity to produce, not recipe executions. Whole batches may produce more; craftedQuantity reports the actual gain. Use an integer number, not a string. Maximum request 64.");

const CraftFromInventoryInputSchema = z.object({
  item: z.string().trim().min(1).describe('Exact output item ID, e.g. "oak_planks" or "crafting_table".'),
  quantity: CraftQuantitySchema,
}).strict().describe('Example: {"item":"oak_planks","quantity":4}. Uses the bot\'s 2x2 inventory grid. No station or tablePosition argument.');

const CraftFromTableInputSchema = z.object({
  item: z.string().trim().min(1).describe('Exact output item ID, e.g. "wooden_pickaxe".'),
  quantity: CraftQuantitySchema,
  tablePosition: BlockPositionSchema,
}).strict().describe('Example: {"item":"wooden_pickaxe","quantity":1,"tablePosition":{"x":2,"y":-60,"z":5}}. Uses an existing reachable table. No station argument.');

export type CraftFromInventoryInput = z.infer<typeof CraftFromInventoryInputSchema>;
export type CraftFromTableInput = z.infer<typeof CraftFromTableInputSchema>;

// The station is an internal engine choice, never a model-supplied argument.
type CraftInput =
  | (CraftFromInventoryInput & { station: "inventory" })
  | (CraftFromTableInput & { station: "crafting_table" });

export interface MissingIngredient {
  item: string;
  required: number;
  available: number;
  missing: number;
}

export interface CraftOutput {
  item: string;
  requestedQuantity: number;
  craftedQuantity: number;
  craftOperations: number;
  station: CraftInput["station"];
}

interface RecipeCandidate {
  recipe: Recipe;
  operations: number;
  missingIngredients: MissingIngredient[];
  missingTotal: number;
  signature: string;
}

export class CraftFromInventoryCapability implements Capability<CraftFromInventoryInput, CraftOutput> {
  readonly name = "craft_from_inventory_2x2";
  readonly inputSchema = CraftFromInventoryInputSchema;
  private readonly crafting: CraftingOperation;
  constructor(timing: ConfirmationTiming = ACTION_CONFIRMATION) { this.crafting = new CraftingOperation(timing); }

  execute(input: CraftFromInventoryInput, context: ExecutionContext): Promise<TaskResult<CraftOutput>> {
    return this.crafting.execute({ ...input, station: "inventory" }, context);
  }
}

export class CraftFromTableCapability implements Capability<CraftFromTableInput, CraftOutput> {
  readonly name = "craft_from_table_3x3";
  readonly inputSchema = CraftFromTableInputSchema;
  private readonly crafting: CraftingOperation;
  constructor(timing: ConfirmationTiming = ACTION_CONFIRMATION) { this.crafting = new CraftingOperation(timing); }

  execute(input: CraftFromTableInput, context: ExecutionContext): Promise<TaskResult<CraftOutput>> {
    return this.crafting.execute({ ...input, station: "crafting_table" }, context);
  }
}

/** Shared recipe selection, physical execution, cancellation and inventory verification. */
class CraftingOperation {
  constructor(private readonly timing: ConfirmationTiming) {}

  async execute(
    input: CraftInput,
    context: ExecutionContext,
  ): Promise<TaskResult<CraftOutput>> {
    const bot = context.runtime.bot;
    const itemName = normalizeMinecraftName(input.item);
    const itemData = bot.registry.itemsByName[itemName];

    if (!itemData) {
      return failure("RECIPE_NOT_FOUND", `Unknown item "${input.item}".`, {
        facts: { item: input.item },
      });
    }

    if (bot.currentWindow) {
      return failure("BLOCKED", "A window is already open.", {
        retryable: true,
        facts: { windowType: bot.currentWindow.type },
      });
    }

    let tableBlock: ReturnType<typeof bot.blockAt> = null;
    let expectedTableStateId: number | null = null;

    if (input.station === "crafting_table") {
      tableBlock = bot.blockAt(toVec3(input.tablePosition));
      if (!tableBlock || tableBlock.name !== "crafting_table") {
        return failure(
          "TARGET_NOT_FOUND",
          "No crafting table exists at the requested position.",
          { facts: { tablePosition: input.tablePosition } },
        );
      }
      if (
        bot.entity.position.distanceTo(tableBlock.position) > 4.5 ||
        !bot.canSeeBlock(tableBlock)
      ) {
        return failure("OUT_OF_REACH", "The crafting table is not reachable.", {
          retryable: true,
          facts: { tablePosition: input.tablePosition },
        });
      }
      expectedTableStateId = tableBlock.stateId;
    }

    const recipes = bot
      .recipesAll(itemData.id, null, tableBlock)
      .filter((recipe) =>
        input.station === "inventory" ? !recipe.requiresTable : true,
      );
    if (recipes.length === 0) {
      return failure(
        "RECIPE_NOT_FOUND",
        `No ${input.station} recipe produces "${itemName}".`,
        { facts: { item: itemName, station: input.station } },
      );
    }

    let observation: ServerInventoryConfirmation | undefined;
    let beforeInventory: Readonly<Record<string, number>> | null = null;
    let confirmedOperations = 0;
    let attemptedOperations = 0;
    let craftedQuantity = 0;
    let expectedGain = 0;
    const progress = () => ({ item: itemName, requestedQuantity: input.quantity, craftedQuantity, expectedGain, confirmedOperations, attemptedOperations });
    const publish = () => context.reportProgress?.({ craft: progress() });
    const unconfirmed = (stage: string, cause?: string): TaskResult<CraftOutput> => {
      const current = observation?.snapshot;
      writeTrace("craft.unconfirmed", { taskId: context.taskId, ...progress(), stage, cause,
        inventoryBefore: beforeInventory, serverInventory: current, localInventory: snapshotInventory(bot) });
      return failure("ACTION_NOT_CONFIRMED", "Crafting effect was not confirmed. Inspect inventory before retrying; some items may already have been produced.", {
        retryable: true,
        facts: { ...progress(), stage, confirmationTimeoutMs: this.timing.timeoutMs,
          observedGain: current && beforeInventory ? (current.items[itemName] ?? 0) - (beforeInventory[itemName] ?? 0) : null,
          ...(cause ? { cause } : {}) },
      });
    };
    const closeCraftingWindow = (): void => {
      const window = bot.currentWindow;
      if (window && String(window.type).startsWith("minecraft:crafting")) {
        void bot.closeWindow(window);
      }
    };
    const closeCraftingWindowAfterAbort = (): void => {
      if (context.signal.aborted) closeCraftingWindow();
    };

    context.signal.throwIfAborted();
    context.signal.addEventListener("abort", closeCraftingWindow, {
      once: true,
    });
    bot.on("windowOpen", closeCraftingWindowAfterAbort);

    try {
      publish();
      observation = new ServerInventoryConfirmation(bot, this.timing);
      if (!await observation.synchronize(context.signal)) return unconfirmed("initial_inventory");
      const initial = observation.snapshot!;
      if (!hasEmptyCraftingArea(initial) || !localCraftingAreaEmpty(bot)) return failure("BLOCKED", "Empty the crafting grid and cursor before crafting.");
      beforeInventory = initial.items;
      const candidates = recipes.map(recipe => buildCandidate(bot, recipe, input.quantity)).sort(compareCandidates);
      const selected = candidates[0]!;
      if (selected.missingTotal > 0) {
        return failure("MISSING_ITEM", `Missing ingredients to craft "${itemName}".`, {
          facts: { item: itemName, station: input.station, recipeSignature: selected.signature, missingIngredients: selected.missingIngredients },
        });
      }
      const expectedInventory = { ...beforeInventory };
      // Mineflayer cannot cancel an inventory craft already in progress. Run
      // one operation at a time and keep the Executor occupied until the
      // current operation settles if the task is interrupted.
      for (
        let operationIndex = 0;
        operationIndex < selected.operations;
        operationIndex += 1
      ) {
        context.signal.throwIfAborted();
        attemptedOperations++;
        publish();
        const craftOperation = bot.craft(
          selected.recipe,
          1,
          tableBlock ?? undefined,
        );
        context.deferCancellationUntil(craftOperation);
        let cause: string | undefined;
        try { await craftOperation; }
        catch (error) { if (context.signal.aborted) throw error; cause = errorMessage(error); }
        context.signal.throwIfAborted();
        for (const delta of selected.recipe.delta) {
          const name = bot.registry.items[delta.id]!.name;
          expectedInventory[name] = (expectedInventory[name] ?? 0) + delta.count;
        }
        expectedGain = (expectedInventory[itemName] ?? 0) - (beforeInventory[itemName] ?? 0);
        const confirmed = await observation.synchronize(context.signal, state =>
          hasEmptyCraftingArea(state) && sameInventory(expectedInventory, state.items) &&
          sameInventory(state.items, snapshotInventory(bot)) && localCraftingAreaEmpty(bot),
        );
        writeTrace("craft.confirmation", { taskId: context.taskId, operation: attemptedOperations, confirmed, cause,
          expectedInventory: { ...expectedInventory }, serverInventory: observation.snapshot, localInventory: snapshotInventory(bot) });
        if (!confirmed) return unconfirmed("recipe", cause);
        confirmedOperations++;
        craftedQuantity = (observation.snapshot!.items[itemName] ?? 0) - (beforeInventory[itemName] ?? 0);
        publish();
      }

      if (input.station === "crafting_table") {
        const tableAfter = bot.blockAt(toVec3(input.tablePosition));
        if (
          !tableAfter ||
          tableAfter.name !== "crafting_table" ||
          tableAfter.stateId !== expectedTableStateId
        ) {
          return failure(
            "WORLD_CHANGED",
            "The crafting table changed while crafting.",
            {
              retryable: true,
              facts: { tablePosition: input.tablePosition, ...progress() },
            },
          );
        }
      }

      if (craftedQuantity < input.quantity) {
        return unconfirmed("final_quantity");
      }

      return success({
        item: itemName,
        requestedQuantity: input.quantity,
        craftedQuantity,
        craftOperations: selected.operations,
        station: input.station,
      });
    } catch (error: unknown) {
      if (context.signal.aborted) throw error;
      if (error instanceof InventoryObservationError) return failure("WORLD_CHANGED", error.message, { facts: progress() });

      const message = errorMessage(error);
      if (message.includes("missing ingredient")) {
        return failure("MISSING_ITEM", message, {
          retryable: true,
          facts: progress(),
        });
      }
      if (
        message.includes("craftingTable") ||
        message.includes("crafting table") ||
        message.includes("window")
      ) {
        return failure("BLOCKED", message, { retryable: true, facts: progress() });
      }
      throw error;
    } finally {
      observation?.dispose();
      context.signal.removeEventListener("abort", closeCraftingWindow);
      bot.removeListener("windowOpen", closeCraftingWindowAfterAbort);
    }
  }
}

function sameInventory(expected: Readonly<Record<string, number>>, actual: Readonly<Record<string, number>>): boolean {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].every(name => (expected[name] ?? 0) === (actual[name] ?? 0));
}

function localCraftingAreaEmpty(bot: ExecutionContext["runtime"]["bot"]): boolean {
  return bot.inventory.selectedItem === null && bot.inventory.slots.slice(0, 5).every(item => item === null);
}

function buildCandidate(
  bot: ExecutionContext["runtime"]["bot"],
  recipe: Recipe,
  requestedQuantity: number,
): RecipeCandidate {
  const operations = Math.ceil(requestedQuantity / recipe.result.count);
  const missingIngredients = recipe.delta
    .filter((delta) => delta.count < 0)
    .map((delta) => ingredientDeficit(bot, delta, operations))
    .filter((ingredient) => ingredient.missing > 0)
    .sort((left, right) => left.item.localeCompare(right.item));

  return {
    recipe,
    operations,
    missingIngredients,
    missingTotal: missingIngredients.reduce(
      (total, ingredient) => total + ingredient.missing,
      0,
    ),
    signature: recipeSignature(bot, recipe),
  };
}

function ingredientDeficit(
  bot: ExecutionContext["runtime"]["bot"],
  ingredient: RecipeItem,
  operations: number,
): MissingIngredient {
  const required = -ingredient.count * operations;
  const available = bot.inventory.count(ingredient.id, ingredient.metadata);
  return {
    item: bot.registry.items[ingredient.id]?.name ?? `item_${ingredient.id}`,
    required,
    available,
    missing: Math.max(required - available, 0),
  };
}

function recipeSignature(
  bot: ExecutionContext["runtime"]["bot"],
  recipe: Recipe,
): string {
  return recipe.delta
    .filter((item) => item.count < 0)
    .map((item) => {
      const name = bot.registry.items[item.id]?.name ?? `item_${item.id}`;
      return `${name}:${item.metadata ?? "*"}:${-item.count}`;
    })
    .sort()
    .join("|");
}

function compareCandidates(
  left: RecipeCandidate,
  right: RecipeCandidate,
): number {
  return (
    left.missingTotal - right.missingTotal ||
    left.signature.localeCompare(right.signature)
  );
}
