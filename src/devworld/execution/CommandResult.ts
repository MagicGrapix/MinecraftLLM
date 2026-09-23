export interface CommandExecutionRecord {
  readonly command: string;
  readonly sentAt: number;
  readonly responses: readonly string[];
  readonly error?: string;
}

export type CommandPlanStatus =
  | "completed"
  | "failed"
  | "interrupted";

export interface CommandResult {
  readonly planId: string;
  readonly description: string;
  readonly status: CommandPlanStatus;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly commandsSent: number;
  readonly records: readonly CommandExecutionRecord[];
  readonly error?: string;
}

export class CommandExecutionStoppedError extends Error {
  constructor(message = "World command executor stopped.") {
    super(message);
    this.name = "CommandExecutionStoppedError";
  }
}
