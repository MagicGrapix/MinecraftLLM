import { randomUUID } from "node:crypto";
import {
  cloneBounds,
  containsBounds,
  unionBounds,
  type ArenaBounds,
} from "./ArenaBounds";

export interface PlannedCommand {
  readonly text: string;
  readonly estimatedBlocksChanged?: number;
  readonly affectedBounds?: ArenaBounds;
}

export interface WorldPlan {
  readonly id: string;
  readonly description: string;
  readonly commands: readonly PlannedCommand[];
  readonly estimatedBlocksChanged: number;
  readonly affectedBounds: ArenaBounds;
}

export type IdSource = () => string;

export interface WorldPlanFactoryOptions {
  readonly arena: ArenaBounds;
  readonly maxPlanCommands: number;
  readonly createId?: IdSource;
}

export class WorldPlanFactory {
  private readonly createId: IdSource;

  constructor(private readonly options: WorldPlanFactoryOptions) {
    if (
      !Number.isInteger(options.maxPlanCommands) ||
      options.maxPlanCommands <= 0
    ) {
      throw new Error("maxPlanCommands must be a positive integer.");
    }
    this.createId = options.createId ?? randomUUID;
  }

  create(
    description: string,
    commands: readonly PlannedCommand[],
  ): WorldPlan {
    const normalizedDescription = description.trim();
    if (!normalizedDescription) {
      throw new Error("World plan description cannot be empty.");
    }
    if (commands.length === 0) {
      throw new Error("World plan must contain at least one command.");
    }
    if (commands.length > this.options.maxPlanCommands) {
      throw new Error(
        `World plan contains ${commands.length} commands; maximum is ${this.options.maxPlanCommands}.`,
      );
    }

    let affectedBounds: ArenaBounds | null = null;
    let estimatedBlocksChanged = 0;
    const clonedCommands = commands.map((command, index) => {
      validateCommand(command, index);
      if (
        command.affectedBounds &&
        !containsBounds(this.options.arena, command.affectedBounds)
      ) {
        throw new Error(
          `Command ${index + 1} affects blocks outside the configured arena.`,
        );
      }
      if (command.affectedBounds) {
        affectedBounds = affectedBounds
          ? unionBounds(affectedBounds, command.affectedBounds)
          : cloneBounds(command.affectedBounds);
      }
      estimatedBlocksChanged += command.estimatedBlocksChanged ?? 0;
      return cloneCommand(command);
    });

    if (!affectedBounds) {
      throw new Error(
        "World plan must contain at least one spatial command.",
      );
    }

    return {
      id: this.createId(),
      description: normalizedDescription,
      commands: clonedCommands,
      estimatedBlocksChanged,
      affectedBounds,
    };
  }
}

function validateCommand(command: PlannedCommand, index: number): void {
  if (
    !command.text ||
    command.text !== command.text.trim() ||
    command.text.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(command.text)
  ) {
    throw new Error(
      `Command ${index + 1} must be trimmed, omit "/", and contain no control characters.`,
    );
  }
  if (
    command.estimatedBlocksChanged !== undefined &&
    (!Number.isInteger(command.estimatedBlocksChanged) ||
      command.estimatedBlocksChanged < 0)
  ) {
    throw new Error(
      `Command ${index + 1} has an invalid block estimate.`,
    );
  }
}

function cloneCommand(command: PlannedCommand): PlannedCommand {
  return {
    text: command.text,
    ...(command.estimatedBlocksChanged === undefined
      ? {}
      : { estimatedBlocksChanged: command.estimatedBlocksChanged }),
    ...(command.affectedBounds
      ? { affectedBounds: cloneBounds(command.affectedBounds) }
      : {}),
  };
}
