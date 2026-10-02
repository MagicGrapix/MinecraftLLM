import type { Bot } from "mineflayer";
import { sleep } from "../../shared/helper";

export interface TransportCommandResult {
  readonly command: string;
  readonly sentAt: number;
  readonly responses: readonly string[];
  readonly error?: string;
}

export interface CommandTransport {
  readonly isClosed: boolean;
  send(command: string): Promise<TransportCommandResult>;
  subscribeClose(listener: (reason: string) => void): () => void;
}

export class MineflayerCommandTransport implements CommandTransport {
  private readonly closeListeners = new Set<(reason: string) => void>();
  private closed = false;
  private closeReason = "Command transport closed.";

  constructor(
    private readonly bot: Bot,
    private readonly responseWindowMs: number,
    private readonly now: () => number = Date.now,
    private readonly wait: (durationMs: number) => Promise<void> = sleep,
  ) {
    if (
      !Number.isInteger(responseWindowMs) ||
      responseWindowMs < 0
    ) {
      throw new Error("responseWindowMs must be a non-negative integer.");
    }
    bot.once("end", this.handleEnd);
    bot.once("kicked", this.handleKicked);
    bot.once("error", this.handleError);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async send(command: string): Promise<TransportCommandResult> {
    if (this.closed) throw new Error(this.closeReason);
    if (
      !command ||
      command.startsWith("/") ||
      /[\u0000-\u001f\u007f]/.test(command)
    ) {
      throw new Error("Transport command must omit '/' and controls.");
    }

    const responses: string[] = [];
    let rejection: string | undefined;
    const collect = (message: string, position?: string, jsonMsg?: unknown): void => {
      if (position === "chat") return;
      responses.push(message);
      if (isCommandRejection(jsonMsg) && !isExpectedNoChange(command, jsonMsg)) rejection = message;
    };
    this.bot.on("messagestr", collect);
    const sentAt = this.now();
    try {
      this.bot.chat(`/${command}`);
      if (this.responseWindowMs > 0) {
        await this.wait(this.responseWindowMs);
      }
      if (this.closed) throw new Error(this.closeReason);
      return { command, sentAt, responses: [...responses], ...(rejection ? { error: rejection } : {}) };
    } finally {
      this.bot.removeListener("messagestr", collect);
    }
  }

  subscribeClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    if (this.closed) listener(this.closeReason);
    return () => this.closeListeners.delete(listener);
  }

  close(reason = "Command transport closed."): void {
    this.markClosed(reason);
    this.bot.removeListener("end", this.handleEnd);
    this.bot.removeListener("kicked", this.handleKicked);
    this.bot.removeListener("error", this.handleError);
  }

  private readonly handleEnd = (reason: string): void => {
    this.markClosed(
      `Minecraft connection ended: ${describeConnectionReason(reason)}`,
    );
  };

  private readonly handleKicked = (reason: string): void => {
    this.markClosed(
      `World controller was kicked: ${describeConnectionReason(reason)}`,
    );
  };

  private readonly handleError = (error: Error): void => {
    this.markClosed(`World controller error: ${error.message}`);
  };

  private markClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const listener of [...this.closeListeners]) listener(reason);
  }
}

/** Best-effort feedback detection, not a command acknowledgement protocol. */
function isCommandRejection(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if (node.color === "red") return true;
  if (typeof node.translate === "string" &&
      /^(command\.unknown|command\.failed|commands\.generic\.|argument\.|arguments\.)|^commands\..*\.(failed|failure|toobig|outOfWorld)/.test(node.translate)) return true;
  return Object.values(node).some((child) =>
    Array.isArray(child) ? child.some(isCommandRejection) : isCommandRejection(child));
}

function isExpectedNoChange(command: string, value: unknown): boolean {
  const keys: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.translate === "string") keys.push(record.translate);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return (command.startsWith("kill @e[") && keys.includes("argument.entity.notfound.entity")) ||
    (command.startsWith("clear ") && keys.includes("clear.failed.single")) ||
    (command.startsWith("effect clear ") && keys.includes("commands.effect.clear.everything.failed")) ||
    (command.startsWith("fill ") && keys.includes("commands.fill.failed"));
}

export function describeConnectionReason(reason: unknown): string {
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}
