export const DEV_WORLD_BLOCKS = {
  air: "minecraft:air",
  bedrock: "minecraft:bedrock",
  dirt: "minecraft:dirt",
  grass: "minecraft:grass_block",
  stone: "minecraft:stone",
  ironOre: "minecraft:iron_ore",
  coalOre: "minecraft:coal_ore",
} as const;

export const ORE_BLOCKS = {
  iron: DEV_WORLD_BLOCKS.ironOre,
  coal: DEV_WORLD_BLOCKS.coalOre,
} as const;

export type OreKind = keyof typeof ORE_BLOCKS;

export interface FlatLayerProfile {
  readonly bedrockY: number;
  readonly lowerDirtY: number;
  readonly upperDirtY: number;
  readonly grassY: number;
  readonly airY: number;
}

export function flatLayerProfile(surfaceY: number): FlatLayerProfile {
  return {
    bedrockY: surfaceY - 3,
    lowerDirtY: surfaceY - 2,
    upperDirtY: surfaceY - 1,
    grassY: surfaceY,
    airY: surfaceY + 1,
  };
}
