import type { z } from "zod";
import type { TaskResult } from "../execution/TaskResult";
import type { Capability, ExecutionContext } from "./Capability";

export interface RegisteredCapability {
  readonly name: string;
  readonly description: string;
  readonly defaultTimeoutMs?: number;
  readonly inputSchema: z.ZodType<unknown>;
  execute(
    input: unknown,
    context: ExecutionContext,
  ): Promise<TaskResult<unknown>>;
}

export interface CapabilitySummary {
  readonly name: string;
  readonly description: string;
}

export type CapabilityValidationResult =
  | { readonly ok: true; readonly input: unknown }
  | {
      readonly ok: false;
      readonly issues: readonly z.ZodIssue[];
    };

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, RegisteredCapability>();
  private frozen = false;

  freeze(): void { this.frozen = true; }

  register<Input, Output>(capability: Capability<Input, Output>): void {
    if (this.frozen) throw new Error("Capability registry is frozen; register tools before runtime assembly.");
    if (this.capabilities.has(capability.name)) {
      throw new Error(`Capability "${capability.name}" is already registered.`);
    }

    this.capabilities.set(capability.name, {
      name: capability.name,
      description:
        capability.description ??
        `Execute the "${capability.name}" Minecraft capability.`,
      inputSchema: capability.inputSchema as z.ZodType<unknown>,
      ...(capability.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: capability.defaultTimeoutMs }),
      execute: (input, context) =>
        capability.execute(input as Input, context),
    });
  }

  get(name: string): RegisteredCapability | undefined {
    return this.capabilities.get(name);
  }

  has(name: string): boolean {
    return this.capabilities.has(name);
  }

  list(): readonly CapabilitySummary[] {
    return [...this.capabilities.values()]
      .map(({ name, description }) => ({ name, description }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  validateInput(
    name: string,
    input: unknown,
  ): CapabilityValidationResult {
    const capability = this.capabilities.get(name);
    if (!capability) return { ok: false, issues: [] };
    const parsed = capability.inputSchema.safeParse(input);
    return parsed.success
      ? { ok: true, input: parsed.data }
      : { ok: false, issues: parsed.error.issues };
  }
}
