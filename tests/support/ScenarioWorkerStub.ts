/** IPC integration fixture. Never connects to Minecraft or Ollama. */
import type { WorkerCommand } from "../e2e/types";
import { observation } from "./ScenarioObservations";
const options = JSON.parse(process.argv[2]!);
let armed = false;
process.send!({ type: "event", event: "ready", data: { sessionId: `fixture_${process.pid}` } });
process.on("message", (input: WorkerCommand) => {
  if (input.command === "shutdown" && options.username === "stuck") return;
  if (input.command === "arm") {
    armed = true;
    process.send!({ type: "event", event: "accepted", data: {} });
  }
  process.send!({ type: "reply", id: input.id, value: input.command === "snapshot" ? observation({
    inventory: { oak_log: armed ? 2 : 0 }, blocks: (input.positions ?? []).map((position) => ({ position, name: "air" })),
  }) : undefined }, () => {
    if (input.command === "shutdown") process.disconnect();
  });
});
