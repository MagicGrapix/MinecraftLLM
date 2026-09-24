import type { Bot } from "mineflayer";
import type { SequentialAgent } from "../agent/SequentialAgent";
import { sleep } from "../shared/helper";

export interface MinecraftChatAdapterOptions {
  readonly bot: Bot;
  readonly agent: SequentialAgent;
  readonly ownerUsername: string;
  readonly maxChunkLength?: number;
  readonly chunkDelayMs?: number;
}

export class MinecraftChatAdapter {
  private readonly maxChunkLength: number;
  private readonly chunkDelayMs: number;
  private attached = false;
  private sendChain = Promise.resolve();

  constructor(private readonly options: MinecraftChatAdapterOptions) {
    this.maxChunkLength = options.maxChunkLength ?? 220;
    this.chunkDelayMs = options.chunkDelayMs ?? 250;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.options.bot.on("chat", this.handleChat);
    console.warn(
      `Chat control owner is "${this.options.ownerUsername}". Offline usernames are not strong authentication.`,
    );
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
        this.options.bot.chat(chunks[index]!);
        if (index + 1 < chunks.length) await sleep(this.chunkDelayMs);
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
    const isOwner = username === this.options.ownerUsername;

    if (command === "stop" || command === "bot stop") {
      if (!isOwner) {
        void this.send("Commande réservée au propriétaire.");
        return;
      }
      void this.options.agent.requestStop(username);
      return;
    }
    if (command === "resume" || command === "bot resume") {
      if (!isOwner) {
        void this.send("Commande réservée au propriétaire.");
        return;
      }
      this.options.agent.requestResume(username);
      return;
    }

    this.options.agent.submitUserMessage(
      username,
      message.trim(),
      !isOwner,
    );
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
