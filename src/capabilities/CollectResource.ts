import { z } from "zod";
import { COLLECTION_LIMITS } from "../collection/CollectionConfig";
import type { CollectInput, CollectionProgress } from "../collection/CollectionTypes";
import { MineflayerCollectionOperations } from "../collection/MineflayerCollectionOperations";
import { resolveResource } from "../collection/ResourceCatalog";
import { ResourceCollector } from "../collection/ResourceCollector";
import { failure, type TaskResult } from "../execution/TaskResult";
import { ServerInventoryConfirmation } from "../runtime/ServerInventoryConfirmation";
import { errorMessage } from "../shared/helper";
import { writeTrace } from "../TraceLog";
import type { Capability, ExecutionContext } from "./Capability";

export class CollectResourceCapability implements Capability<CollectInput, CollectionProgress> {
  readonly name = "collect_resource";
  readonly defaultTimeoutMs = COLLECTION_LIMITS.timeoutMs;
  readonly inputSchema = z.object({
    item: z.string().trim().min(1).describe('Exact resource item ID, e.g. "oak_log", "dirt" or "cobblestone". Not a category like "wood".'),
    quantity: z.number().int().min(1).max(COLLECTION_LIMITS.maxQuantity)
      .describe("Additional inventory items to obtain (1–256), not the final stock or number of source blocks to break."),
  }).strict();

  async execute(input: CollectInput, context: ExecutionContext): Promise<TaskResult<CollectionProgress>> {
    const bot = context.runtime.bot;
    context.signal.throwIfAborted();
    const resource = resolveResource(input.item, bot.registry);
    if (!resource.ok) return resource;
    if (bot.currentWindow) return failure("BLOCKED", "Close the current container before collecting.");
    const unavailable = new AbortController();
    const origin = bot.entity.position.clone();
    const ended = () => unavailable.abort(new Error("Connection or player state changed during collection."));
    const checkBounds = () => {
      if (bot.entity.position.distanceTo(origin) > COLLECTION_LIMITS.maxRadius) unavailable.abort(new Error("Bot left the collection area."));
    };
    for (const event of ["end", "death", "respawn"] as const) bot.on(event, ended);
    bot.on("physicsTick", checkBounds);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("Collection deadline reached.")), COLLECTION_LIMITS.timeoutMs);
    const signal = AbortSignal.any([context.signal, unavailable.signal, deadline.signal]);
    let observation: ServerInventoryConfirmation | undefined;
    let progress: CollectionProgress | undefined;
    try {
      observation = new ServerInventoryConfirmation(bot);
      return await new ResourceCollector(new MineflayerCollectionOperations({ ...context, signal }, observation))
        .collect(resource.value, input.quantity, {
          signal,
          progress: value => { progress = value; context.reportProgress?.({ collect: value }); },
          trace: event => writeTrace("collect.event", { taskId: context.taskId, ...event }),
        });
    } catch (error) {
      context.signal.throwIfAborted();
      writeTrace("collect.error", { taskId: context.taskId, error: errorMessage(error) });
      return failure(deadline.signal.aborted ? "TIMEOUT" : "WORLD_CHANGED", errorMessage(error).replace(/\s+/g, " ").slice(0, 240), { facts: { ...(progress ? { progress } : {}) } });
    } finally {
      clearTimeout(timer); observation?.dispose();
      bot.removeListener("physicsTick", checkBounds);
      for (const event of ["end", "death", "respawn"] as const) bot.removeListener(event, ended);
    }
  }
}
