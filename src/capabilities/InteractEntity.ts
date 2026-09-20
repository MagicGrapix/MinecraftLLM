import type { Entity } from "prismarine-entity";
import type { Window } from "prismarine-windows";
import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import type { Capability, ExecutionContext } from "./Capability";

export interface InteractEntityInput {
  entityId: number;
  expectedType?: string;
  hand: "hand";
  interaction: "activate" | "use_on";
}

export interface InteractEntityOutput {
  entityId: number;
  entityType: string;
  interaction: InteractEntityInput["interaction"];
  confirmedBy: "entity_update" | "mount" | "window_opened";
}

export class InteractEntityCapability
  implements Capability<InteractEntityInput, InteractEntityOutput>
{
  readonly name = "interact_entity";
  readonly inputSchema: z.ZodType<InteractEntityInput> = z
    .object({
      entityId: z.number().int().nonnegative(),
      expectedType: z.string().trim().min(1).optional(),
      hand: z.literal("hand"),
      interaction: z.enum(["activate", "use_on"]),
    })
    .strict();

  async execute(
    input: InteractEntityInput,
    context: ExecutionContext,
  ): Promise<TaskResult<InteractEntityOutput>> {
    const bot = context.runtime.bot;
    const entity = bot.entities[input.entityId];
    if (!entity) {
      return failure(
        "ENTITY_NOT_FOUND",
        `Entity ${input.entityId} does not exist.`,
        { retryable: true, facts: { entityId: input.entityId } },
      );
    }
    const entityType = entity.name ?? entity.type;
    if (input.expectedType && entityType !== input.expectedType) {
      return failure(
        "WORLD_CHANGED",
        `Expected entity type "${input.expectedType}" but found "${entityType}".`,
        { retryable: true, facts: { entityId: input.entityId } },
      );
    }
    if (entity.position.distanceTo(bot.entity.position) > 4.5) {
      return failure("OUT_OF_REACH", `Entity ${input.entityId} is out of reach.`, {
        retryable: true,
        facts: { entityId: input.entityId },
      });
    }
    if (bot.currentWindow) {
      return failure("BLOCKED", "A window is already open.", {
        retryable: true,
      });
    }

    let confirmation: InteractEntityOutput["confirmedBy"] | null = null;
    let openedWindow: Window | null = null;
    const markUpdate = (target: Entity): void => {
      if (target.id === input.entityId) confirmation = "entity_update";
    };
    const markMount = (): void => {
      confirmation = "mount";
    };
    const markWindow = (window: Window): void => {
      openedWindow = window;
      confirmation = "window_opened";
      void bot.closeWindow(window);
    };
    try {
      context.signal.throwIfAborted();
      await bot.lookAt(
        entity.position.offset(0, Math.max(entity.height / 2, 0.5), 0),
        true,
      );
      context.signal.throwIfAborted();
      if (!bot.entities[input.entityId]) {
        return failure(
          "ENTITY_NOT_FOUND",
          `Entity ${input.entityId} disappeared before interaction.`,
          { retryable: true, facts: { entityId: input.entityId } },
        );
      }

      bot.on("entityUpdate", markUpdate);
      bot.on("mount", markMount);
      bot.on("windowOpen", markWindow);
      if (input.interaction === "activate") {
        await bot.activateEntity(entity);
      } else {
        bot.useOn(entity);
      }

      for (let tick = 0; tick < 10 && !confirmation; tick += 1) {
        context.signal.throwIfAborted();
        await bot.waitForTicks(1);
      }
      context.signal.throwIfAborted();

      if (!confirmation) {
        return failure(
          "ACTION_NOT_CONFIRMED",
          `No interaction effect was observed for entity ${input.entityId}.`,
          { retryable: true, facts: { entityId: input.entityId } },
        );
      }

      if (openedWindow && bot.currentWindow === openedWindow) {
        await bot.closeWindow(openedWindow);
      }
      return success({
        entityId: input.entityId,
        entityType,
        interaction: input.interaction,
        confirmedBy: confirmation,
      });
    } finally {
      bot.removeListener("entityUpdate", markUpdate);
      bot.removeListener("mount", markMount);
      bot.removeListener("windowOpen", markWindow);
    }
  }
}
