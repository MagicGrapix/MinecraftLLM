import { fork, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { bounded, message, until } from "./async";
import type { Observation, TrialAgent, WorkerCommand, WorkerEvent, WorkerReply } from "./types";
import type { WorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";

/** Owns exactly one Node child, never a shell or a user's existing bot process. */
export class AgentProcess implements TrialAgent {
  acceptedAt: number | null = null;
  finished: { at: number; error?: string } | null = null;
  failure: string | null = null;
  sessionId: string | null = null;
  private ready = false;
  private exited = false;
  private closing = false;
  private nextId = 0;
  private readonly child: ChildProcess;
  private readonly output: WriteStream;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly exit: Promise<void>;

  constructor(config: WorldBuilderConfig, trialDirectory: string, promptsDirectory: string,
    private readonly record: (event: string, data: unknown) => void,
    workerPath = resolve("tests/e2e/agent-worker.ts")) {
    this.output = createWriteStream(join(trialDirectory, "process.log"), { flags: "a" });
    this.child = fork(workerPath, [JSON.stringify({
      host: config.host, port: config.port, version: config.version, username: config.agentUsername,
      auth: "offline", controllerUsername: config.controllerUsername,
      promptsDirectory, landmarksFile: join(trialDirectory, "landmarks.json"),
    })], {
      execArgv: ["-r", require.resolve("ts-node/register")],
      env: { ...process.env, LOG_DIR: trialDirectory, LOG_FULL_TRACE: "true" },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    });
    this.output.on("error", (error) => { this.failure = `Process log failed: ${message(error)}`; });
    this.child.stdout?.pipe(this.output, { end: false });
    this.child.stderr?.pipe(this.output, { end: false });
    this.child.on("message", (value: WorkerEvent | WorkerReply) => this.receive(value));
    this.child.on("error", (error) => { this.failure = message(error); });
    this.exit = new Promise((resolveExit) => {
      this.child.once("exit", (code, signal) => {
        this.exited = true;
        if (!this.closing) this.failure ??= `Bot process exited (${code ?? signal}).`;
        for (const pending of this.pending.values()) pending.reject(new Error("Bot process exited."));
        this.pending.clear();
        this.record("process.exit", { code, signal });
      });
      this.child.once("close", () => { this.output.end(() => resolveExit()); });
    });
  }

  async waitReady(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await until(() => { this.assertHealthy(); return this.ready; }, timeoutMs, "Bot readiness", signal);
  }
  snapshot(): Promise<Observation> { return this.call("snapshot", 3_000); }
  async arm(text: string): Promise<void> { await this.call("arm", 3_000, { text }); }

  async close(graceMs: number): Promise<boolean> {
    this.closing = true;
    if (this.exited) { await bounded(this.exit, 3_000, "Process output flush"); return false; }
    let forced = false;
    try {
      await this.call("shutdown", graceMs + 2_000, { graceMs });
      await bounded(this.exit, 3_000, "Bot process exit");
    } catch (error) {
      forced = true;
      this.record("process.force_stop", { error: message(error) });
      if (!this.exited) this.child.kill("SIGKILL");
      await bounded(this.exit, 5_000, "Forced bot process exit");
    }
    return forced;
  }

  private async call(command: WorkerCommand["command"], timeoutMs: number, args: Partial<WorkerCommand> = {}): Promise<any> {
    if (this.exited || !this.child.connected) throw new Error("Bot IPC is disconnected.");
    const id = ++this.nextId;
    const response = new Promise((resolveResult, reject) => {
      this.pending.set(id, { resolve: resolveResult, reject });
      this.child.send({ ...args, id, command }, (error) => { if (error) reject(error); });
    });
    try { return await bounded(response, timeoutMs, `Worker ${command}`); }
    finally { this.pending.delete(id); }
  }
  private assertHealthy(): void { if (this.failure) throw new Error(this.failure); }
  private receive(value: WorkerEvent | WorkerReply): void {
    if (value.type === "reply") {
      const pending = this.pending.get(value.id);
      if (value.error) pending?.reject(new Error(value.error)); else pending?.resolve(value.value);
      return;
    }
    if (value.type !== "event") return;
    this.record(`agent.${value.event}`, value.data);
    if (value.event === "ready") { this.ready = true; this.sessionId = value.data.sessionId; }
    if (value.event === "accepted") {
      if (this.acceptedAt !== null) this.failure = "More than one request was accepted in an isolated trial.";
      else this.acceptedAt = performance.now();
    }
    if (value.event === "finished") this.finished = { at: performance.now(), ...(value.data.error ? { error: value.data.error } : {}) };
    if (value.event === "failure") this.failure = value.data.error;
  }
}
