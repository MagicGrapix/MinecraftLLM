import { z } from "zod";
import { formatInventoryDiff, type ToolCallJournal } from "../../execution/ToolCallJournal";
import { queryFailure, querySuccess } from "./QueryResult";
import type { WorldQuery } from "./WorldQuery";

const inputSchema = z.object({
  actionNumber: z.number().int().positive().describe('Tool action number from a previous result, not a checklist step or LLM call. Example: {"actionNumber":12}.'),
}).strict();

export function inventoryDiffQuery(journal: ToolCallJournal): WorldQuery<z.infer<typeof inputSchema>, unknown> {
  return {
    name: "get_inventory_diff_after",
    description: "Does: Compare the bot inventory saved immediately before and after one numbered tool call.\nReturns: A fixed Git-style diff, or no changes.\nLimits: Not a comparison with now; excludes later pickups and does not prove causation.\nNotes: Use actionNumber from tool results. Only capabilities and run_step have snapshots. Records last for the current player request; failed actions can also change inventory.",
    inputSchema,
    execute: async ({ actionNumber }) => {
      const record = journal.get(actionNumber);
      if (!record) return queryFailure("INVALID_ARGUMENT", `Action #${actionNumber} is not in the current request journal. Use an actionNumber from this request's tool results.`);
      if (!record.tracksInventory) return queryFailure("INVALID_ARGUMENT", `Action #${actionNumber} (${record.tool}) is not an inventory-tracked call. No snapshots were recorded.`);
      if (!record.completed) return queryFailure("OBSERVATION_UNAVAILABLE", `Action #${actionNumber} is still running; its after snapshot is not available yet.`);
      if (record.before === null || record.after === null) return queryFailure("OBSERVATION_UNAVAILABLE", `Inventory unavailable for action #${actionNumber} (disconnected, unobservable, or action still settling). This is not an empty inventory or a zero diff.`);
      return querySuccess({ actionNumber, tool: record.tool, toolSucceeded: record.ok, diff: formatInventoryDiff(record) });
    },
  };
}
