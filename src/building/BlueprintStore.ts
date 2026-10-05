import { randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { BLUEPRINT_FORMAT_VERSION, type Blueprint, type MaterialRequirement } from "./Blueprint";
import { BlueprintValidator } from "./BlueprintValidator";
import { BLUEPRINT_LIMITS } from "./BuildingConfig";

export const BlueprintIdSchema = z.string().regex(/^bp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const idSchema = BlueprintIdSchema;
const fileSchema = z.object({
  id: idSchema,
  formatVersion: z.number().int(),
  minecraftVersion: z.string().min(1).max(80),
  blueprint: z.unknown(),
  materials: z.array(z.object({
    item: z.string().min(1).max(128),
    quantity: z.number().int().min(1).max(BLUEPRINT_LIMITS.maxWidth * BLUEPRINT_LIMITS.maxDepth * BLUEPRINT_LIMITS.maxHeight),
  }).strict()).max(BLUEPRINT_LIMITS.maxPalette + BLUEPRINT_LIMITS.maxDoors),
}).strict();

export interface StoredBlueprint {
  readonly id: string;
  readonly formatVersion: typeof BLUEPRINT_FORMAT_VERSION;
  readonly minecraftVersion: string;
  readonly blueprint: Blueprint;
  readonly materials: readonly MaterialRequirement[];
}

export interface BlueprintStoreOptions {
  /** Controlled by the application, never by a model tool argument. */
  readonly directory?: string;
  readonly createId?: () => string;
}

/** Immutable files only; every read revalidates the drawing and recomputes its materials. */
export class BlueprintStore {
  readonly directory: string;
  private readonly createId: () => string;

  constructor(private readonly validator: BlueprintValidator, options: BlueprintStoreOptions = {}) {
    this.directory = resolve(options.directory ?? join("data", "blueprints"));
    this.createId = options.createId ?? (() => `bp_${randomUUID()}`);
  }

  async save(input: unknown): Promise<TaskResult<StoredBlueprint>> {
    const validation = this.validator.validate(input);
    if (!validation.ok) return validation;
    const id = this.createId();
    if (!idSchema.safeParse(id).success) {
      return failure("INTERNAL_ERROR", "Blueprint ID generator returned an invalid ID.", { facts: { reason: "INVALID_BLUEPRINT_ID" } });
    }
    const record: StoredBlueprint = {
      id, formatVersion: BLUEPRINT_FORMAT_VERSION,
      minecraftVersion: validation.value.minecraftVersion,
      blueprint: validation.value.blueprint, materials: validation.value.materials,
    };
    const content = JSON.stringify(record, null, 2) + "\n";
    if (Buffer.byteLength(content) > BLUEPRINT_LIMITS.maxFileBytes) {
      return failure("INVALID_ARGUMENT", "Blueprint file exceeds the storage size limit.", { facts: { reason: "BLUEPRINT_TOO_LARGE" } });
    }
    const temporary = join(this.directory, `.${id}.${randomUUID()}.tmp`);
    let ownsTemporary = false;
    try {
      await mkdir(this.directory, { recursive: true });
      const handle = await open(temporary, "wx");
      ownsTemporary = true;
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      // Atomic publication without replacement (rename can overwrite an existing immutable ID).
      // Source and destination share a directory/filesystem. No non-atomic fallback on failure.
      await link(temporary, join(this.directory, `${id}.json`));
      return success(record);
    } catch (error: unknown) {
      return ioFailure(error, "save");
    } finally {
      if (ownsTemporary) {
        try { await unlink(temporary); }
        catch (error: unknown) {
          console.warn("Could not remove blueprint temporary file.", { id, fsCode: fsCode(error) });
        }
      }
    }
  }

  async load(id: string): Promise<TaskResult<StoredBlueprint>> {
    if (!idSchema.safeParse(id).success) {
      return failure("INVALID_ARGUMENT", "Use a generated blueprint ID, not a name or file path.", { facts: { reason: "INVALID_BLUEPRINT_ID" } });
    }
    let text: string;
    try { text = await readBounded(join(this.directory, `${id}.json`)); }
    catch (error: unknown) {
      if (fsCode(error) === "ENOENT") return failure("TARGET_NOT_FOUND", "Blueprint reference was not found.", { facts: { id } });
      if (error instanceof RangeError) return invalidFile(error.message);
      return ioFailure(error, "load");
    }
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { return invalidFile("Blueprint file contains invalid JSON."); }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) return invalidFile("Blueprint file has an invalid storage envelope.");
    const record = parsed.data;
    if (record.id !== id) return invalidFile("Blueprint file ID does not match the requested reference.");
    if (record.formatVersion !== BLUEPRINT_FORMAT_VERSION) return invalidFile("Blueprint format version is not supported.");
    if (record.minecraftVersion !== this.validator.catalog.minecraftVersion) {
      return failure("WORLD_CHANGED", "Blueprint was saved for a different Minecraft version; submit it again for validation.", {
        facts: { reason: "BLUEPRINT_VERSION_MISMATCH", storedVersion: record.minecraftVersion,
          currentVersion: this.validator.catalog.minecraftVersion },
      });
    }
    const validation = this.validator.validate(record.blueprint);
    if (!validation.ok) return validation;
    if (JSON.stringify(record.materials) !== JSON.stringify(validation.value.materials)) {
      return invalidFile("Saved material quantities do not match the validated blueprint.");
    }
    return success({ id, formatVersion: BLUEPRINT_FORMAT_VERSION, minecraftVersion: record.minecraftVersion,
      blueprint: validation.value.blueprint, materials: validation.value.materials });
  }
}

/** Read at most limit+1 bytes, even if an external editor grows the file during the read. */
async function readBounded(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new RangeError("Blueprint reference must identify a regular file.");
    const buffer = Buffer.alloc(BLUEPRINT_LIMITS.maxFileBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > BLUEPRINT_LIMITS.maxFileBytes) throw new RangeError("Blueprint file exceeds the storage size limit.");
    return buffer.toString("utf8", 0, size);
  } finally { await handle.close(); }
}

function invalidFile(message: string): TaskResult<never> {
  return failure("INVALID_ARGUMENT", message, { facts: { reason: "INVALID_BLUEPRINT_FILE" } });
}

function fsCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function ioFailure(error: unknown, operation: string): TaskResult<never> {
  return failure("INTERNAL_ERROR", `Could not ${operation} blueprint; no existing blueprint was overwritten.`, {
    facts: { reason: "BLUEPRINT_IO_ERROR", fsCode: fsCode(error) },
  });
}
