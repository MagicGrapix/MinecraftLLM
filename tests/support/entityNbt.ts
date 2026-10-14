import type { Bot } from "mineflayer";

/** OP test controller only; independent of the tested bot's inventory cache. */
export function entityNbt(bot: Bot, entityId: number, transactionId: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); bot._client.removeListener("nbt_query_response", receive); bot.removeListener("end", ended); };
    const receive = (packet: { transactionId: number; nbt: unknown }) => {
      if (packet.transactionId === transactionId) { cleanup(); resolve(packet.nbt); }
    };
    const ended = () => { cleanup(); reject(new Error("Controller disconnected during inventory read")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Controller entity NBT query timed out")); }, 3000);
    bot._client.on("nbt_query_response", receive); bot.on("end", ended);
    try { bot._client.write("query_entity_nbt", { transactionId, entityId }); }
    catch (error) { cleanup(); reject(error); }
  });
}
