import type { Task } from "./Task";
import type { TaskResult } from "./TaskResult";

export interface TaskExecutor {
  execute(task: Task): Promise<TaskResult>;
  abortCurrent(reason?: string): boolean;
}
