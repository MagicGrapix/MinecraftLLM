import type { Bot } from "mineflayer";
import { sleep } from "../../shared/helper";

export interface TransportCommandResult {
  readonly command: string;
  readonly sentAt: number;
  readonly responses: readonly string[];
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
    const collect = (message: string): void => {
      responses.push(message);
    };
    this.bot.on("messagestr", collect);
    const sentAt = this.now();
    try {
      this.bot.chat(`/${command}`);
      if (this.responseWindowMs > 0) {
        await this.wait(this.responseWindowMs);
      }
      if (this.closed) throw new Error(this.closeReason);
      return { command, sentAt, responses: [...responses] };
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

export function describeConnectionReason(reason: unknown): string {
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}
