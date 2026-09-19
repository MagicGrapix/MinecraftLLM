import type { Task } from "./Task";

export class ExecutionQueue {
  private items: Task[] = [];

  enqueue(task: Task): void {
    this.items.push(task);
  }

  enqueueMany(tasks: readonly Task[]): void {
    this.items.push(...tasks);
  }

  prepend(task: Task): void {
    this.items.unshift(task);
  }

  dequeue(): Task | undefined {
    return this.items.shift();
  }

  peek(): Task | undefined {
    return this.items[0];
  }

  clear(): void {
    this.items = [];
  }

  remove(taskId: string): Task | undefined {
    const index = this.items.findIndex((task) => task.id === taskId);
    if (index < 0) return undefined;
    return this.items.splice(index, 1)[0];
  }

  replace(tasks: readonly Task[]): void {
    this.items = [...tasks];
  }

  toArray(): readonly Task[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }
}
