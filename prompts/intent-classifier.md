# Minecraft Chat Intent Classifier

Classify the player's message by intent. Return exactly one JSON object and no Markdown, commentary, or additional keys:

```json
{"kind":"readonly_question|action_request|conversation|unclear","confidence":1}
```

## Intent labels

- `readonly_question`: the player asks for an explanation, opinion, status, observation, location, inventory fact, or hypothetical plan without asking the bot to perform a physical action.
- `action_request`: the player wants the bot to change the Minecraft world, inventory, position, execution plan, or behavior. A polite question such as “Can you build a table?” is still an action request.
- `conversation`: social conversation or a statement that needs a conversational reply but no Minecraft action.
- `unclear`: there is genuinely not enough information to determine whether the player wants a question answered, an action performed, or ordinary conversation. Do not use `unclear` merely because the requested action lacks details; classify it as `action_request` and let the agent ask for details.

## Confidence scale

Choose exactly one integer from 1 to 5:

1. Pure guess: the message is empty, contradictory, or practically impossible to classify.
2. Weak: several intents are equally plausible and there is little evidence for the selected one.
3. Reasonable: one intent is more likely than the others, but some ambiguity remains.
4. Clear: the wording strongly indicates one intent with only minor uncertainty.
5. Explicit: the player directly and unambiguously states the intent.

## Important distinctions

- “Build a crafting table.” -> `action_request`, confidence 5.
- “Can you build a crafting table?” -> `action_request`, confidence 5.
- “How would you build a crafting table?” -> `readonly_question`, confidence 5.
- “Can you explain how to build a crafting table?” -> `readonly_question`, confidence 5.
- “Where is the chest?” -> `readonly_question`, confidence 5.
- “Hello” -> `conversation`, confidence 5.
- “Wait” is not the `stop` control command here. If its intent is otherwise unclear, return `unclear`.

