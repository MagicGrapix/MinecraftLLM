# Agent workflow

In agent mode, Minecraft chat goes to `WorkflowAgent`. There is no separate intent-classifier call. The coordinator reads the current user request, recent verbatim conversation, ongoing factual summary, checklist, inventory, self state, and landmarks. It chooses one next sequence: reply, call the planner, or delegate one step to the action agent.

The planner is a single structured LLM call. It receives the same conversation history and current world snapshot, and returns high-level steps with observable success criteria. The coordinator may call it again after a failure or world change. The action agent receives one step and may inspect the world, create a short local `TaskSpec` plan, and execute one capability at a time through the existing `SequentialPlanRunner` and `Executor`. It returns a report to the coordinator; it does not speak to the player or edit the global checklist.

The coordinator owns the checklist. It can mark `- [x]` only for the step named in a matching successful action report. It then decides whether the entire user request is complete. A factual `agent_summary_<session>.md` is written under `logs/` after each handoff. The conversation history is kept for the running bot session and included in coordinator/planner requests up to the configured context budget; the inspector shows exactly which messages were sent and how many older entries were omitted. The action agent's private context is cleared before each delegation.

Prompts are separate Markdown files in `prompts/`: `coordinator.md`, `planner.md`, and `actioner.md`. Restart the bot after editing them. The old intent and memory prompt files are not used by the production workflow.

Only the configured owner can request planning or actions. Other players can receive read-only replies. While a run is active, ordinary chat messages are ignored; `stop` aborts the current LLM call or physical action, and `resume` causes the coordinator to re-check the current state before continuing. The bot still uses the existing Mineflayer capabilities and has no new administrator permissions.

Run `npm.cmd test` for build, type checks, and unit tests. For the live test, start the Minecraft server and Ollama, run `npm.cmd run dev`, then try a read-only question followed by a small action (for example, ask it to collect one nearby log). Use the inspector at `http://127.0.0.1:3001/` to follow `coordinator`, `planner`, `actioner_planning`, and `actioner_review` rounds.
