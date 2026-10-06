import type { RunningAgentRuntime } from "../../src/bootstrap/createAgentRuntime";
import { bounded } from "./async";

/** Worker lifecycle only. Test-specific runners do not become production agent modes. */
export interface TrialRuntime {
  state(): { mode: string; planSteps: number; completedSteps: number };
  isPhysicallyIdle(): boolean;
  attach(prompt: string): void;
  detach(): void;
  settle(graceMs: number): Promise<void>;
  shutdown(): Promise<void>;
}

export function workflowTrialRuntime(running: RunningAgentRuntime): TrialRuntime {
  return {
    state: () => ({ mode: (running.agent.state() as { mode: string }).mode,
      planSteps: running.agent.task.steps.length,
      completedSteps: running.agent.task.steps.filter(s => s.status === "done").length }),
    isPhysicallyIdle: () => running.isPhysicallyIdle(),
    attach: () => running.chat.attach(), detach: () => running.chat.detach(),
    settle: async graceMs => {
      running.chat.detach();
      await bounded((async () => {
        await running.agent.shutdown();
        await running.waitForPhysicalIdle(graceMs);
      })(), graceMs, "Stop agent and settle physical action");
    },
    shutdown: () => running.shutdown("Scenario trial finished."),
  };
}
