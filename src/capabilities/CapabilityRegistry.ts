import type { z } from "zod";
import type { TaskResult } from "../execution/TaskResult";
import type { Capability, ExecutionContext } from "./Capability";

export interface RegisteredCapability {
  readonly name: string;
  readonly inputSchema: z.ZodType<unknown>;
  execute(
    input: unknown,
    context: ExecutionContext,
  ): Promise<TaskResult<unknown>>;
}

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, RegisteredCapability>();

  register<Input, Output>(capability: Capability<Input, Output>): void {
    if (this.capabilities.has(capability.name)) {
      throw new Error(`Capability "${capability.name}" is already registered.`);
    }

    this.capabilities.set(capability.name, {
      name: capability.name,
      inputSchema: capability.inputSchema as z.ZodType<unknown>,
      execute: (input, context) =>
        capability.execute(input as Input, context),
    });
  }

  get(name: string): RegisteredCapability | undefined {
    return this.capabilities.get(name);
  }

  list(): readonly string[] {
    return [...this.capabilities.keys()];
  }
}
