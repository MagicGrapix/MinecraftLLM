/** Limits for the offline blueprint format, not Minecraft engine limits. */
export const BLUEPRINT_LIMITS = Object.freeze({
  maxWidth: 8,
  maxDepth: 8,
  maxHeight: 5,
  maxPalette: 16,
  maxDoors: 16,
  maxIssues: 20,
  maxFileBytes: 65_536,
});

/** Only plain, non-falling, full cubes; placement/stateful blocks come in later lots. */
export const BLUEPRINT_SOLID_BLOCKS: readonly string[] = Object.freeze([
  "oak_planks", "spruce_planks", "birch_planks", "jungle_planks",
  "acacia_planks", "dark_oak_planks", "mangrove_planks", "cherry_planks",
  "pale_oak_planks", "bamboo_planks", "crimson_planks", "warped_planks",
  "cobblestone", "stone", "dirt", "glass",
]);

/** Local safety policy, not Minecraft engine limits. No automatic scaffolding. */
export const BUILD_LIMITS = Object.freeze({
  timeoutMs: 300_000,
  maxRadius: 50,
  workMargin: 2,
  maxCandidates: 8,
  placementReach: 4.5,
  confirmationMs: 3_000,
});

/** Includes invalid responses/corrections; summary calls use the shared bounded compactor. */
export const ARCHITECT_LIMITS = Object.freeze({
  maxCalls: 8,
  maxTokens: 4_096,
  summaryRetries: 2,
});
