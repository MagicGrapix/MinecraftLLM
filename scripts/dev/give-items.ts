import "../src/Logger";
import { MINECRAFT_VERSION } from "../../src/config";
import { MinecraftRuntime } from "../../src/runtime/MinecraftRuntime";
import { sleep } from "../../src/shared/helper";

async function main(): Promise<void> {
  const item = process.argv[2];
  const count = Number(process.argv[3] ?? "1");

  if (!item || !Number.isInteger(count) || count <= 0) {
    throw new Error(
      "Usage: npm run dev:give -- <minecraft:item_name> [positive-count]",
    );
  }

  const runtime = new MinecraftRuntime({
    host: process.env.MINECRAFT_HOST ?? "localhost",
    port: Number(process.env.MINECRAFT_PORT ?? "25565"),
    username: process.env.MINECRAFT_USERNAME ?? "bot",
    version: MINECRAFT_VERSION,
  });

  try {
    await runtime.connect();
    runtime.bot.chat(`/give @s ${item} ${count}`);
    await sleep(500);
    console.info(`Requested ${count} x ${item} for ${runtime.bot.username}.`);
  } finally {
    runtime.disconnect("Dev give command complete.");
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
