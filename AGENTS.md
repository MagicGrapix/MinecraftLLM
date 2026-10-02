# Project guidance

Read `docs/architecture.md` before changing component boundaries, then only the relevant linked docs.
When changing agents, context, tools, execution, world-building or debug contracts, update the affected
documentation in the same change. Document actual behavior and limits, not future intentions.
For example, a new query needs its registry/schema, regression tests and an update to the tool/context docs.

Keep production prompts in `prompts/`, smoke fixtures in `tests/fixtures/prompts/`, test doubles in
`tests/support/`. Preserve the user's unfinished agent prompts unless their edits are explicitly in scope.
Run `npm.cmd test`. Do not launch live Minecraft/Ollama smoke tests without checking the task's scope.
