import type { TaskSpec } from "../execution/Task";

export type AgentFinishStatus = "success" | "failure" | "needs_user";

export type AgentDecision =
  | { readonly type: "set_plan"; readonly tasks: readonly TaskSpec[] }
  | { readonly type: "continue_plan" }
  | {
      readonly type: "finish_step";
      readonly status: AgentFinishStatus;
      readonly message: string;
    };
