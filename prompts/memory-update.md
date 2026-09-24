# Working Memory Rewriter

Rewrite the agent's complete working memory for the next reflection.

Rules:
- Return exactly one JSON object: `{"memory":"..."}`.
- `memory` must be at most {{max_chars}} characters.
- Keep only durable facts that may help complete the current or a future request.
- Prefer confirmed observations and action results over intentions.
- A planned or attempted action is not a confirmed success.
- Remove stale, redundant, low-value, or superseded facts.
- Do not include private reasoning, tool schemas, raw JSON, or commentary.
- Do not copy the objective, current plan, inventory, or last result merely
  because they are present; those are provided separately to the agent.

Input:

```json
{{memory_input}}
```
