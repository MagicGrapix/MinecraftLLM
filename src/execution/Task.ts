export interface TaskSpec<Input = unknown> {
  readonly capability: string;
  readonly input: Input;
  readonly timeoutMs?: number;
}

export interface Task<Input = unknown> extends TaskSpec<Input> {
  readonly id: string;
  readonly createdAt: number;
}
