# Block access diagnostics

`get_block_access({ position: { x: 7, y: -59, z: 4 } })` is a read-only World Query exposed through the existing coordinator and action-agent catalogs. Coordinates must be integers. It never turns the bot's head, moves, changes blocks, or creates tasks. It does not change the actioner's `set_plan` / `continue_plan` architecture.

Example tool result:

```json
{
  "ok": true,
  "value": {
    "position": { "x": 7, "y": -59, "z": 4 },
    "loaded": true,
    "block": "oak_log",
    "distanceFromEyes": 3.3,
    "reach": 5,
    "withinReach": true,
    "visible": false,
    "canDig": false,
    "reason": "occluded",
    "blocker": { "block": "oak_leaves", "position": { "x": 8, "y": -59, "z": 4 } }
  }
}
```

`distanceFromEyes` measures the current eye position to the **block center**. `reach` is the **eye-to-face** raycast limit, so do not compare these numbers as if they used the same endpoint. `withinReach` combines Mineflayer's separate center gate with the nearest tested visible face distance; if no face is visible it uses the nearest candidate face. Visibility is a geometric test of Mineflayer's dig face centers, not whether the camera currently points at the block. Collision shapes matter: an empty half-slab does not obscure a ray like a full cube.

The implementation follows installed Mineflayer 4.39.0: `canDigBlock` uses a 5.1-block center gate from a fixed 1.65 eye offset; `dig(block, false, "raycast")` tests candidate faces with the current eye height and a 5-block ray. This query uses Prismarine's ray iterator and shape intersections without mutating cached blocks, and also detects unloaded cells along the ray. Visibility inspection is bounded to 64 blocks; beyond that it remains unknown.

`canDig` is true only when the target passes this local geometry preflight, is diggable, the bot is grounded, and no other dig is active. It is **not** a pathfinding result, a general reach guarantee for `place`/`use_block`, a harvest-tool check, proof of server permission, or proof that a dropped item will be collected. `DigCapability` may wait for ground before starting; a query made while airborne reports `not_on_ground` for the current instant. The world may change after this snapshot.

Reasons are `accessible`, `unloaded`, `empty`, `not_diggable`, `out_of_reach`, `occluded`, `visibility_unknown`, `no_visible_face`, `not_on_ground`, or `already_digging`. `blocker` identifies one measured obstruction, not necessarily all obstacles. Unknown visibility is `null`, not `false`; a missing target has `loaded: false`, `block: null`, and unknown measurements. Known air has `loaded: true`, `block: "air"`, and `reason: "empty"`. A diagnosed obstruction is a successful query (`ok: true`, `canDig: false`), not a tool execution error.

Calculations and raw query/debug records keep full precision. Existing message-history presentation rounds numbers to two decimals for the model. No extra context snapshot or LLM call is introduced.

Restart the bot, not the Minecraft server, to load the new tool. In chat, try asking the bot to check access to a known block at explicit coordinates. Automated tests cover the query schema, adapter, visibility/reach, unknown terrain, local readiness, tool catalogs and presentation. Live server acceptance still needs a Minecraft test.
