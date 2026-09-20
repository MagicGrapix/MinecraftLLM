import type { Entity } from "prismarine-entity";
import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import type { Capability, ExecutionContext } from "./Capability";

export interface AttackInput {
  entityId: number;
  expectedType?: string;
}

export interface AttackOutput {
  entityId: number;
  entityType: string;
  outcome: "hurt" | "dead" | "gone";
}

export class AttackCapability
  implements Capability<AttackInput, AttackOutput>
{
  readonly name = "attack";
  readonly inputSchema: z.ZodType<AttackInput> = z
    .object({
      entityId: z.number().int().nonnegative(),
      expectedType: z.string().trim().min(1).optional(),
    })
    .strict();

  async execute(
    input: AttackInput,
    context: ExecutionContext,
  ): Promise<TaskResult<AttackOutput>> {
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

    let outcome: AttackOutput["outcome"] | null = null;
    const markHurt = (target: Entity): void => {
      if (target.id === input.entityId) outcome = "hurt";
    };
    const markDead = (target: Entity): void => {
      if (target.id === input.entityId) outcome = "dead";
    };
    const markGone = (target: Entity): void => {
      if (target.id === input.entityId) outcome = "gone";
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
          `Entity ${input.entityId} disappeared before the attack.`,
          { retryable: true, facts: { entityId: input.entityId } },
        );
      }

      bot.on("entityHurt", markHurt);
      bot.on("entityDead", markDead);
      bot.on("entityGone", markGone);
      bot.attack(entity);
      for (let tick = 0; tick < 10 && !outcome; tick += 1) {
        context.signal.throwIfAborted();
        await bot.waitForTicks(1);
        if (!bot.entities[input.entityId]) outcome = "gone";
      }
      context.signal.throwIfAborted();

      if (!outcome) {
        return failure(
          "ACTION_NOT_CONFIRMED",
          `No hit confirmation was observed for entity ${input.entityId}.`,
          { retryable: true, facts: { entityId: input.entityId } },
        );
      }
      return success({ entityId: input.entityId, entityType, outcome });
    } finally {
      bot.removeListener("entityHurt", markHurt);
      bot.removeListener("entityDead", markDead);
      bot.removeListener("entityGone", markGone);
    }
  }
}
