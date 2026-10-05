import { z } from "zod";
import { Builder } from "../building/Builder";
import { BlueprintIdSchema, BlueprintStore } from "../building/BlueprintStore";
import { BlueprintValidator } from "../building/BlueprintValidator";
import { BUILD_LIMITS } from "../building/BuildingConfig";
import type { BuildInput, BuildProgress } from "../building/BuildTypes";
import { MineflayerBuildOperations } from "../building/MineflayerBuildOperations";
import type { TaskResult } from "../execution/TaskResult";
import { BlockPositionSchema } from "../shared/types";
import { MaterialCatalog } from "../world/MaterialCatalog";
import { writeTrace } from "../TraceLog";
import type { Capability, ExecutionContext } from "./Capability";

export class BuildCapability implements Capability<BuildInput, BuildProgress> {
  readonly name = "build";
  readonly defaultTimeoutMs = BUILD_LIMITS.timeoutMs;
  readonly inputSchema = z.object({
    blueprintId: BlueprintIdSchema.describe("Existing saved blueprint reference, bp_<uuid>. Not a drawing or a file path."),
    origin: BlockPositionSchema.describe("Fixed world cell for blueprint local (0,0,0), its lowest north-west corner. Reuse this exact origin to resume."),
  }).strict();
  constructor(private readonly directory?: string) {}

  async execute(input: BuildInput, context: ExecutionContext): Promise<TaskResult<BuildProgress>> {
    context.signal.throwIfAborted();
    const validator = new BlueprintValidator(new MaterialCatalog(context.runtime.bot.registry));
    const saved = await new BlueprintStore(validator, { directory: this.directory }).load(input.blueprintId);
    context.signal.throwIfAborted();
    if (!saved.ok) return saved;
    const compiled = validator.validate(saved.value.blueprint);
    if (!compiled.ok) return compiled;
    return new Builder(new MineflayerBuildOperations(context)).build(compiled.value, input, {
      signal: context.signal,
      progress: (progress) => context.reportProgress?.({ build: progress }),
      trace: (event) => writeTrace("build.event", { taskId: context.taskId, blueprintId: input.blueprintId, origin: input.origin, ...event }),
    });
  }
}
