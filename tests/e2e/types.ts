import type { Position } from "../../src/shared/types";
import type { WorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import type { WorldPlan } from "../../src/devworld/WorldPlan";

export interface BlockObservation { position: Position; name: string | null }
export interface ContainerObservation {
  position: Position;
  inventory: Record<string, number> | null;
  error?: { code: string; message: string; path?: string; sample?: string };
}
export interface DropObservation { position: Position; item: string | null; count: number | null }
export interface ContainerFixture { position: Position; items: Readonly<Record<string, number>> }
export interface DropFixture { position: Position; item: string; count: number }

export interface Observation {
  inventory: Record<string, number>;
  /** Only cells requested by the scenario. null means unavailable, never air. */
  blocks: readonly BlockObservation[];
  containers?: readonly ContainerObservation[];
  drops?: readonly DropObservation[];
  position: Position;
  yaw: number;
  pitch: number;
  health: number;
  food: number;
  effects: number;
  onGround: boolean;
  physicalIdle: boolean;
  windowOpen: boolean;
  mode: string;
  planSteps: number;
  completedSteps: number;
}

export interface Criterion { passed: boolean; expected: string; actual: string }
export interface Scenario {
  id: string;
  prompt: string;
  timeoutMs?: number;
  initialInventory: Readonly<Record<string, number>>;
  /** Controlled Hunger effect during setup; no active effect when the request starts. */
  hungry?: boolean;
  fixture?: (config: WorldBuilderConfig) => WorldPlan;
  expectedBlocks?: (config: WorldBuilderConfig) => readonly { position: Position; name: string }[];
  /** Fixed cells to observe during setup and execution; never injected into LLM context. */
  observeBlocks?: (config: WorldBuilderConfig) => readonly Position[];
  containers?: (config: WorldBuilderConfig) => readonly ContainerFixture[];
  drops?: (config: WorldBuilderConfig) => readonly DropFixture[];
  verify(initial: Observation, current: Observation): Criterion;
}

export type TrialStatus = "passed" | "failed" | "timeout" | "error";
export interface TrialResult {
  scenario: string;
  status: TrialStatus;
  timeoutMs: number;
  startedAt: string;
  durationMs: number;
  setupMs?: number;
  goalReachedAtMs: number | null;
  criterion?: Criterion;
  initial?: Observation;
  final?: Observation;
  error?: string;
  forcedShutdown?: boolean;
}

export interface TraceEvent { timestamp: string; event: string; data: any }
export interface WorkerEvent { type: "event"; event: string; data: any }
export interface WorkerReply { type: "reply"; id: number; value?: any; error?: string }
export interface WorkerCommand { id: number; command: "snapshot" | "arm" | "shutdown"; text?: string; graceMs?: number; positions?: readonly Position[] }

export interface TrialAgent {
  snapshot(positions?: readonly Position[]): Promise<Observation>;
  arm(prompt: string): Promise<void>;
  acceptedAt: number | null;
  finished: { at: number; error?: string } | null;
  failure: string | null;
}
