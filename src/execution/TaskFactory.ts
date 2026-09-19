import { randomUUID } from "node:crypto";
import type { Task, TaskSpec } from "./Task";

export class TaskFactory {
  constructor(
    private readonly createId: () => string = randomUUID,
    private readonly now: () => number = Date.now,
  ) {}

  create<Input>(spec: TaskSpec<Input>): Task<Input> {
    return {
      ...spec,
      input: structuredClone(spec.input),
      id: this.createId(),
      createdAt: this.now(),
    };
  }

  createMany(specs: readonly TaskSpec[]): Task[] {
    return specs.map((spec) => this.create(spec));
  }
}
