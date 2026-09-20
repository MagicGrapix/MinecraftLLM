import { randomUUID } from "node:crypto";
import type { Bot } from "mineflayer";
import type { Window } from "prismarine-windows";
import type { Position } from "../shared/types";

export interface ContainerSession {
  readonly sessionId: string;
  readonly windowId: number;
  readonly blockPosition: Position;
  readonly windowType: string;
}

export type ContainerSessionResolution =
  | {
      readonly ok: true;
      readonly session: ContainerSession;
      readonly window: Window;
    }
  | {
      readonly ok: false;
      readonly reason: "missing" | "mismatch" | "closing";
    };

interface ActiveContainerSession {
  readonly public: ContainerSession;
  readonly window: Window;
}

export class ContainerSessionManager {
  private active: ActiveContainerSession | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly bot: Bot,
    private readonly createId: () => string = randomUUID,
  ) {}

  snapshot(): ContainerSession | null {
    return this.active ? { ...this.active.public } : null;
  }

  create(window: Window, blockPosition: Position): ContainerSession {
    if (this.active || this.closing) {
      throw new Error("A container session is already active or closing.");
    }
    if (this.bot.currentWindow !== window) {
      throw new Error("The opened window is no longer the current window.");
    }

    const session: ContainerSession = {
      sessionId: this.createId(),
      windowId: window.id,
      blockPosition: { ...blockPosition },
      windowType: String(window.type),
    };
    this.active = { public: session, window };
    return { ...session };
  }

  resolve(sessionId: string): ContainerSessionResolution {
    if (this.closing) return { ok: false, reason: "closing" };
    if (!this.active) return { ok: false, reason: "missing" };
    if (this.active.public.sessionId !== sessionId) {
      return { ok: false, reason: "mismatch" };
    }
    if (
      this.bot.currentWindow !== this.active.window ||
      this.active.window.id !== this.active.public.windowId ||
      String(this.active.window.type) !== this.active.public.windowType
    ) {
      const unexpectedWindow = this.bot.currentWindow;
      if (unexpectedWindow && unexpectedWindow !== this.active.window) {
        void this.bot.closeWindow(unexpectedWindow);
      }
      void this.closeActive("Container session state changed.");
      return { ok: false, reason: "mismatch" };
    }

    return {
      ok: true,
      session: { ...this.active.public },
      window: this.active.window,
    };
  }

  closeActive(_reason = "Container session closed."): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const active = this.active;
    if (!active) return Promise.resolve();

    this.closing = true;
    const completion = Promise.resolve()
      .then(async () => {
        if (this.bot.currentWindow === active.window) {
          await this.bot.closeWindow(active.window);
        }
      })
      .finally(() => {
        if (this.active === active) this.active = null;
        this.closing = false;
        this.closePromise = null;
      });
    this.closePromise = completion;
    return completion;
  }

  async close(sessionId: string): Promise<boolean> {
    const resolved = this.resolve(sessionId);
    if (!resolved.ok) return false;
    await this.closeActive("close_container");
    return true;
  }
}
