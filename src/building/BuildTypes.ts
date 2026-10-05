import type { Block } from "prismarine-block";
import type { Vec3 } from "vec3";
import type { PlaceInput } from "../capabilities/Place";
import type { TaskError, TaskResult } from "../execution/TaskResult";
import type { Position } from "../shared/types";
import type { DoorPlacement } from "./Blueprint";

export interface BuildInput { blueprintId: string; origin: Position }

export interface BuildProgress extends BuildInput {
  dimension: string;
  durationMs: number;
  phase: "preflight" | "building" | "exit" | "verifying" | "complete";
  total: number;
  /** Fresh world observations; already-correct blocks need not have been placed by us. */
  correct: number;
  alreadyCorrect: number;
  placedThisCall: number;
  remaining: number;
}

/** Primitive operations share the enclosing Executor context; never re-enter Executor. */
export interface BuildOperations {
  blockAt(position: Position): Block | null;
  position(): Vec3;
  eyes(): Vec3 | null;
  inventory(): ReadonlyMap<string, number>;
  readonly minY: number;
  readonly maxY: number;
  readonly dimension: string;
  move(position: Position): Promise<TaskResult>;
  place(input: PlaceInput, block: string): Promise<TaskResult>;
  placeDoor(door: DoorPlacement): Promise<TaskResult>;
}

export interface BuildEvent {
  event: "started" | "move_started" | "move_finished" | "place_started" | "place_confirmed" | "finished";
  position?: Position;
  block?: string;
  code?: string;
  error?: TaskError;
  progress?: BuildProgress;
}
