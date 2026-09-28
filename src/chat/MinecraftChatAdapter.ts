import type { Bot } from "mineflayer";
import { sleep } from "../shared/helper";

export interface ChatControlledAgent {
  submitUserMessage(username: string, text: string): void;
  requestStop(username: string): Promise<void>;
  requestResume(username: string): void;
}

export interface MinecraftChatAdapterOptions {
  readonly bot: Bot;
  readonly agent: ChatControlledAgent;
  readonly maxChunkLength?: number;
  readonly minMessageIntervalMs?: number;
}

export class MinecraftChatAdapter {
  private readonly maxChunkLength: number;
  private readonly minMessageIntervalMs: number;
  private lastMessageSentAt: number | null = null;
  private attached = false;
  private sendChain = Promise.resolve();

  constructor(private readonly options: MinecraftChatAdapterOptions) {
    this.maxChunkLength = options.maxChunkLength ?? 220;
    this.minMessageIntervalMs = options.minMessageIntervalMs ?? 1_100;
    if (
      !Number.isFinite(this.minMessageIntervalMs) ||
      this.minMessageIntervalMs < 0
    ) {
      throw new Error("minMessageIntervalMs must be a non-negative number.");
    }
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.options.bot.on("chat", this.handleChat);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.options.bot.removeListener("chat", this.handleChat);
  }

  send(message: string): Promise<void> {
    const chunks = splitChatMessage(message, this.maxChunkLength);
    const operation = this.sendChain.then(async () => {
      for (let index = 0; index < chunks.length; index += 1) {
        if (this.lastMessageSentAt !== null) {
          const remaining =
            this.minMessageIntervalMs -
            (Date.now() - this.lastMessageSentAt);
          if (remaining > 0) await sleep(remaining);
        }
        this.options.bot.chat(chunks[index]!);
        this.lastMessageSentAt = Date.now();
      }
    });
    this.sendChain = operation.catch(() => undefined);
    return operation;
  }

  private readonly handleChat = (
    username: string,
    message: string,
  ): void => {
    if (!this.attached || username === this.options.bot.username) return;
    const command = normalizeCommand(message);
    if (command === "stop" || command === "bot stop") {
      void this.options.agent.requestStop(username);
      return;
    }
    if (command === "resume" || command === "bot resume") {
      this.options.agent.requestResume(username);
      return;
    }

    this.options.agent.submitUserMessage(username, message.trim());
  };
}

export function splitChatMessage(
  message: string,
  maxLength = 220,
): readonly string[] {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength + 1);
    const breakAt = candidate.lastIndexOf(" ");
    const length = breakAt > 0 ? breakAt : maxLength;
    chunks.push(remaining.slice(0, length).trim());
    remaining = remaining.slice(length).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function normalizeCommand(message: string): string {
  return message.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr");
}
