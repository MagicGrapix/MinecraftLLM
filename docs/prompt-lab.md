# Prompt Lab

Run `npm.cmd run lab` from the project root, then open <http://127.0.0.1:3002/>. Ollama must be running with the model configured by `LLM_MODEL` (the agent defaults to `qwen3.5:9b`). The lab does **not** connect to Minecraft or start the game server.

The lab uses the real intent router, prompts, skills, agent loop, memory updater, tool schemas, and local LLM. World queries read a small editable simulated scenario. When the agent executes a task, it pauses at an action checkpoint until you click **Approve success** or **Inject failure**. Approval applies the corresponding simulated effect to the world; an injected failure leaves it unchanged. The current world and memory are visible beside the conversation, and the embedded inspector shows exact LLM requests and responses.

The first iteration simulates `goto`, `dig`, `equip`, and `place`. Other Minecraft capabilities are deliberately unavailable in the lab for now, so a craft/smelting scenario cannot yet be exercised end-to-end. The default scenario starts with one oak log in inventory and three nearby log blocks over a flat grass/dirt/bedrock layer. Edit the JSON and click **Reset with this scenario** to start a fresh run; reset reloads prompt Markdown files and clears the lab conversation and memory.

Use `LAB_PORT` to change the HTTP port. The server listens on `127.0.0.1` only. The normal agent and Minecraft server can remain running independently.
