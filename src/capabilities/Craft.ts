import type { Recipe, RecipeItem } from "prismarine-recipe";
import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import {
  countInventoryItem,
  snapshotInventory,
} from "../runtime/InventoryAdapter";
import { toVec3 } from "../runtime/PositionAdapter";
import { errorMessage, normalizeMinecraftName } from "../shared/helper";
import { BlockPositionSchema } from "../shared/types";
import type { Capability, ExecutionContext } from "./Capability";

const MAX_CRAFT_OUTPUT_QUANTITY = 64;

const CraftInputSchema = z.discriminatedUnion("station", [
  z
    .object({
      item: z.string().trim().min(1).describe('Exact output item ID, e.g. "oak_planks".'),
      quantity: z.number().int().positive().max(MAX_CRAFT_OUTPUT_QUANTITY).describe("Requested output item quantity, not recipe executions; recipes may yield more. Maximum 64."),
      station: z.literal("inventory").describe("Use the bot's 2x2 crafting grid; no tablePosition."),
    })
    .strict(),
  z
    .object({
      item: z.string().trim().min(1).describe('Exact output item ID, e.g. "wooden_pickaxe".'),
      quantity: z.number().int().positive().max(MAX_CRAFT_OUTPUT_QUANTITY).describe("Requested output item quantity, not recipe executions; recipes may yield more. Maximum 64."),
      station: z.literal("crafting_table").describe("Use an existing reachable 3x3 crafting table; tablePosition is required."),
      tablePosition: BlockPositionSchema,
    })
    .strict(),
]).describe('Example: {"item":"oak_planks","quantity":4,"station":"inventory"}. For station="crafting_table", also supply integer tablePosition as {"x":2,"y":-60,"z":5}.');

export type CraftInput = z.infer<typeof CraftInputSchema>;

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

export class CraftCapability implements Capability<CraftInput, CraftOutput> {
  readonly name = "craft";
  readonly inputSchema: z.ZodType<CraftInput> = CraftInputSchema;

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

    const candidates = recipes
      .map((recipe) => buildCandidate(bot, recipe, input.quantity))
      .sort(compareCandidates);
    const selected = candidates[0]!;
    if (selected.missingTotal > 0) {
      return failure(
        "MISSING_ITEM",
        `Missing ingredients to craft "${itemName}".`,
        {
          facts: {
            item: itemName,
            station: input.station,
            recipeSignature: selected.signature,
            missingIngredients: selected.missingIngredients,
          },
        },
      );
    }

    const beforeCount = countInventoryItem(bot, itemName);
    const beforeInventory = snapshotInventory(bot);
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
      // Mineflayer cannot cancel an inventory craft already in progress. Run
      // one operation at a time and keep the Executor occupied until the
      // current operation settles if the task is interrupted.
      for (
        let operationIndex = 0;
        operationIndex < selected.operations;
        operationIndex += 1
      ) {
        context.signal.throwIfAborted();
        const craftOperation = bot.craft(
          selected.recipe,
          1,
          tableBlock ?? undefined,
        );
        context.deferCancellationUntil(craftOperation);
        await craftOperation;
        context.signal.throwIfAborted();
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
              facts: { tablePosition: input.tablePosition },
            },
          );
        }
      }

      const craftedQuantity = countInventoryItem(bot, itemName) - beforeCount;
      if (craftedQuantity < input.quantity) {
        return failure(
          "ACTION_NOT_CONFIRMED",
          `Crafting did not produce the requested quantity of "${itemName}".`,
          {
            retryable: true,
            facts: {
              requestedQuantity: input.quantity,
              craftedQuantity,
              inventoryBefore: beforeInventory,
              inventoryAfter: snapshotInventory(bot),
            },
          },
        );
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

      const message = errorMessage(error);
      if (message.includes("missing ingredient")) {
        return failure("MISSING_ITEM", message, {
          retryable: true,
          facts: { item: itemName },
        });
      }
      if (
        message.includes("craftingTable") ||
        message.includes("crafting table") ||
        message.includes("window")
      ) {
        return failure("BLOCKED", message, { retryable: true });
      }
      throw error;
    } finally {
      context.signal.removeEventListener("abort", closeCraftingWindow);
      bot.removeListener("windowOpen", closeCraftingWindowAfterAbort);
    }
  }
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
