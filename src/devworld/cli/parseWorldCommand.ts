import type { OreKind } from "../BlockCatalog";

export type GenerativeWorldCommand =
  | { readonly kind: "tree"; readonly radius?: number }
  | {
      readonly kind: "forest";
      readonly trees: number;
      readonly radius: number;
    }
  | {
      readonly kind: "ore";
      readonly ore: OreKind;
      readonly size: number;
    };

export type WorldCliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "status" }
  | GenerativeWorldCommand
  | { readonly kind: "clear" }
  | { readonly kind: "clear_inventory" }
  | { readonly kind: "reset" }
  | { readonly kind: "scene_list" }
  | SceneWorldCommand
  | {
      readonly kind: "preview";
      readonly command: GenerativeWorldCommand | SceneWorldCommand;
    }
  | { readonly kind: "quit" };

export type SceneWorldCommand = { readonly kind: "scene"; readonly id: number };

export class WorldCommandParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldCommandParseError";
  }
}

export function parseWorldCommand(input: string): WorldCliCommand {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new WorldCommandParseError("Enter a command. Use help.");
  }
  const [name, ...arguments_] = tokens;
  switch (name!.toLowerCase()) {
    case "help":
      requireArgumentCount(name!, arguments_, 0);
      return { kind: "help" };
    case "status":
      requireArgumentCount(name!, arguments_, 0);
      return { kind: "status" };
    case "clear":
      requireArgumentCount(name!, arguments_, 0);
      return { kind: "clear" };
    case "inventory":
      if (
        arguments_.length !== 2 ||
        arguments_[0]?.toLowerCase() !== "clear" ||
        arguments_[1]?.toLowerCase() !== "all"
      ) {
        throw new WorldCommandParseError("Usage: inventory clear all");
      }
      return { kind: "clear_inventory" };
    case "reset":
      requireArgumentCount(name!, arguments_, 0);
      return { kind: "reset" };
    case "quit":
      requireArgumentCount(name!, arguments_, 0);
      return { kind: "quit" };
    case "tree":
      return parseTree(arguments_);
    case "forest":
      return parseForest(arguments_);
    case "ore":
      return parseOre(arguments_);
    case "scene":
      requireArgumentCount(name!, arguments_, 1);
      return arguments_[0]!.toLowerCase() === "list"
        ? { kind: "scene_list" }
        : { kind: "scene", id: positiveInteger(arguments_[0]!, "scene id") };
    case "preview": {
      if (arguments_.length === 0) {
        throw new WorldCommandParseError(
          "Usage: preview tree [radius] | preview forest <trees> <radius> | preview ore <iron|coal> <size> | preview scene <id>",
        );
      }
      const nested = parseWorldCommand(arguments_.join(" "));
      if (
        nested.kind !== "tree" &&
        nested.kind !== "forest" &&
        nested.kind !== "ore" &&
        nested.kind !== "scene"
      ) {
        throw new WorldCommandParseError(
          "preview supports only tree, forest, ore, and scene <id>.",
        );
      }
      return { kind: "preview", command: nested };
    }
    default:
      throw new WorldCommandParseError(
        `Unknown command "${name}". Use help.`,
      );
  }
}

function parseTree(arguments_: readonly string[]): GenerativeWorldCommand {
  if (arguments_.length > 1) {
    throw new WorldCommandParseError("Usage: tree [radius]");
  }
  return arguments_[0]
    ? { kind: "tree", radius: positiveInteger(arguments_[0], "radius") }
    : { kind: "tree" };
}

function parseForest(
  arguments_: readonly string[],
): GenerativeWorldCommand {
  requireArgumentCount("forest", arguments_, 2);
  return {
    kind: "forest",
    trees: positiveInteger(arguments_[0]!, "trees"),
    radius: positiveInteger(arguments_[1]!, "radius"),
  };
}

function parseOre(arguments_: readonly string[]): GenerativeWorldCommand {
  requireArgumentCount("ore", arguments_, 2);
  const ore = arguments_[0]!.toLowerCase();
  if (ore !== "iron" && ore !== "coal") {
    throw new WorldCommandParseError(
      'Ore must be either "iron" or "coal".',
    );
  }
  return {
    kind: "ore",
    ore,
    size: positiveInteger(arguments_[1]!, "size"),
  };
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new WorldCommandParseError(
      `${label} must be a positive integer.`,
    );
  }
  return parsed;
}

function requireArgumentCount(
  command: string,
  arguments_: readonly string[],
  count: number,
): void {
  if (arguments_.length !== count) {
    throw new WorldCommandParseError(
      `${command} expects ${count} argument${count === 1 ? "" : "s"}.`,
    );
  }
}
