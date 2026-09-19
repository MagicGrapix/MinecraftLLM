import { readFile, realpath } from "node:fs/promises";
import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import { isPathInside } from "../shared/helper";
import type { WorldQueryRegistry } from "../world/queries/WorldQueryRegistry";
import {
  parseSkillDocument,
  type LoadedSkill,
} from "./Skill";
import type { SkillRegistry } from "./SkillRegistry";

export class SkillLoader {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly capabilities: CapabilityRegistry,
    private readonly queries: WorldQueryRegistry,
  ) {}

  async load(name: string): Promise<LoadedSkill> {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
      throw new Error(`Unsafe skill name "${name}".`);
    }

    const registered = this.registry.get(name);
    if (!registered) {
      throw new Error(`Unknown skill "${name}".`);
    }

    const [rootPath, filePath] = await Promise.all([
      realpath(this.registry.rootPath),
      realpath(registered.filePath),
    ]);
    if (!isPathInside(rootPath, filePath)) {
      throw new Error(`Skill "${name}" resolves outside the skills root.`);
    }

    const parsed = parseSkillDocument(
      await readFile(filePath, "utf8"),
      filePath,
    );
    if (parsed.name !== name) {
      throw new Error(
        `Loaded skill name "${parsed.name}" does not match "${name}".`,
      );
    }

    const missingCapabilities = parsed.requiredCapabilities.filter(
      (capability) => !this.capabilities.get(capability),
    );
    const missingQueries = parsed.requiredQueries.filter(
      (query) => !this.queries.has(query),
    );
    if (missingCapabilities.length > 0 || missingQueries.length > 0) {
      throw new Error(
        [
          `Skill "${name}" has unavailable dependencies.`,
          missingCapabilities.length > 0
            ? `Missing capabilities: ${missingCapabilities.join(", ")}.`
            : "",
          missingQueries.length > 0
            ? `Missing queries: ${missingQueries.join(", ")}.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    return {
      name: parsed.name,
      description: parsed.description,
      requiredCapabilities: [...parsed.requiredCapabilities],
      requiredQueries: [...parsed.requiredQueries],
      instructions: parsed.instructions,
    };
  }
}
