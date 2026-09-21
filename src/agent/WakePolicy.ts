import type { ExecutionEvent } from "../execution/ExecutionController";
import type { AgentWakeEvent } from "./AgentMailbox";

export class WakePolicy {
  fromExecutionEvent(event: ExecutionEvent): AgentWakeEvent | null {
    if (event.type === "task_finished") {
      return { type: "execution_finished", event };
    }
    if (event.type === "queue_idle") {
      return { type: "execution_idle", event };
    }
    return null;
  }
}
