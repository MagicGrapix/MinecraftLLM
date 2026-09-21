import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { PositionSchema, type Position } from "../shared/types";

export type LandmarkKind =
  | "crafting_table"
  | "chest"
  | "bed"
  | "base"
  | "custom";
export type LandmarkStatus = "confirmed" | "stale" | "missing";
export type LandmarkSource = "observed" | "user" | "agent";

export interface Landmark {
  readonly id: string;
  readonly name: string;
  readonly kind: LandmarkKind;
  readonly dimension: string;
  readonly position: Position;
  readonly source: LandmarkSource;
  readonly status: LandmarkStatus;
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly lastVerifiedAt: number | null;
}

export interface RememberLandmarkInput {
  readonly name: string;
  readonly kind: LandmarkKind;
  readonly dimension: string;
  readonly position: Position;
  readonly source: LandmarkSource;
  readonly pinned: boolean;
}

const LandmarkSchema: z.ZodType<Landmark> = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum([
      "crafting_table",
      "chest",
      "bed",
      "base",
      "custom",
    ]),
    dimension: z.string().min(1),
    position: PositionSchema,
    source: z.enum(["observed", "user", "agent"]),
    status: z.enum(["confirmed", "stale", "missing"]),
    pinned: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    lastVerifiedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

const FileSchema = z
  .object({
    version: z.literal(1),
    landmarks: z.array(LandmarkSchema),
  })
  .strict();

export class LandmarkMemory {
  private readonly landmarks = new Map<string, Landmark>();
  private persistTail: Promise<void> = Promise.resolve();

  private constructor(
    readonly filePath: string,
    initial: readonly Landmark[],
    private readonly createId: () => string = randomUUID,
    private readonly now: () => number = Date.now,
  ) {
    for (const landmark of initial) {
      this.landmarks.set(landmark.id, cloneLandmark(landmark));
    }
  }

  static async load(
    filePath: string,
    options: {
      createId?: () => string;
      now?: () => number;
    } = {},
  ): Promise<LandmarkMemory> {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return new LandmarkMemory(
          filePath,
          [],
          options.createId,
          options.now,
        );
      }
      throw error;
    }

    try {
      const parsed = FileSchema.parse(JSON.parse(content));
      return new LandmarkMemory(
        filePath,
        parsed.landmarks,
        options.createId,
        options.now,
      );
    } catch (error: unknown) {
      const backupPath = `${filePath}.corrupt-${Date.now()}`;
      await rename(filePath, backupPath);
      throw new Error(
        `Landmark file is corrupt; moved to "${backupPath}".`,
        { cause: error },
      );
    }
  }

  list(): readonly Landmark[] {
    return [...this.landmarks.values()]
      .map(cloneLandmark)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  pinned(): readonly Landmark[] {
    return this.list().filter((landmark) => landmark.pinned);
  }

  async remember(input: RememberLandmarkInput): Promise<Landmark> {
    const existing = [...this.landmarks.values()].find(
      (landmark) =>
        landmark.name.toLowerCase() === input.name.toLowerCase() &&
        landmark.dimension === input.dimension,
    );
    const timestamp = this.now();
    const landmark: Landmark = {
      id: existing?.id ?? this.createId(),
      name: input.name,
      kind: input.kind,
      dimension: input.dimension,
      position: { ...input.position },
      source: input.source,
      status: "confirmed",
      pinned: input.pinned,
      createdAt: existing?.createdAt ?? timestamp,
      lastVerifiedAt:
        input.source === "observed" ? timestamp : existing?.lastVerifiedAt ?? null,
    };
    this.landmarks.set(landmark.id, landmark);
    await this.persist();
    return cloneLandmark(landmark);
  }

  async forget(id: string): Promise<boolean> {
    const removed = this.landmarks.delete(id);
    if (removed) await this.persist();
    return removed;
  }

  async markStatus(
    id: string,
    status: LandmarkStatus,
    verified = false,
  ): Promise<Landmark | null> {
    const existing = this.landmarks.get(id);
    if (!existing) return null;
    const updated: Landmark = {
      ...existing,
      status,
      lastVerifiedAt: verified ? this.now() : existing.lastVerifiedAt,
    };
    this.landmarks.set(id, updated);
    await this.persist();
    return cloneLandmark(updated);
  }

  async markAtPosition(
    dimension: string,
    position: Position,
    status: LandmarkStatus,
    verified = false,
  ): Promise<readonly Landmark[]> {
    const updated: Landmark[] = [];
    for (const landmark of this.landmarks.values()) {
      if (
        landmark.dimension !== dimension ||
        landmark.position.x !== position.x ||
        landmark.position.y !== position.y ||
        landmark.position.z !== position.z
      ) {
        continue;
      }
      const next: Landmark = {
        ...landmark,
        status,
        lastVerifiedAt: verified ? this.now() : landmark.lastVerifiedAt,
      };
      this.landmarks.set(next.id, next);
      updated.push(next);
    }
    if (updated.length > 0) await this.persist();
    return updated.map(cloneLandmark);
  }

  async verifyBlock(
    dimension: string,
    position: Position,
    blockName: string | null,
    chunkLoaded: boolean,
  ): Promise<readonly Landmark[]> {
    const changed: Landmark[] = [];
    for (const landmark of this.landmarks.values()) {
      if (
        landmark.dimension !== dimension ||
        landmark.position.x !== position.x ||
        landmark.position.y !== position.y ||
        landmark.position.z !== position.z ||
        landmark.kind === "base" ||
        landmark.kind === "custom"
      ) {
        continue;
      }
      const status: LandmarkStatus = !chunkLoaded
        ? "stale"
        : blockMatchesLandmark(landmark.kind, blockName)
          ? "confirmed"
          : "missing";
      const updated: Landmark = {
        ...landmark,
        status,
        lastVerifiedAt: chunkLoaded ? this.now() : landmark.lastVerifiedAt,
      };
      this.landmarks.set(updated.id, updated);
      changed.push(updated);
    }
    if (changed.length > 0) await this.persist();
    return changed.map(cloneLandmark);
  }

  persist(): Promise<void> {
    const content = `${JSON.stringify(
      { version: 1, landmarks: this.list() },
      null,
      2,
    )}\n`;
    const operation = this.persistTail.then(() =>
      this.writeSnapshot(content),
    );
    // A failed write is still reported to its caller, but must not poison all
    // future writes queued behind it.
    this.persistTail = operation.catch(() => undefined);
    return operation;
  }

  private async writeSnapshot(content: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, this.filePath);
  }
}

function cloneLandmark(landmark: Landmark): Landmark {
  return {
    ...landmark,
    position: { ...landmark.position },
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function blockMatchesLandmark(
  kind: LandmarkKind,
  blockName: string | null,
): boolean {
  if (!blockName) return false;
  if (kind === "crafting_table") return blockName === "crafting_table";
  if (kind === "chest") {
    return (
      blockName === "chest" ||
      blockName === "trapped_chest" ||
      blockName === "barrel" ||
      blockName.endsWith("_shulker_box")
    );
  }
  if (kind === "bed") return blockName.endsWith("_bed");
  return true;
}
