import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  parseSkillDocument,
  type SkillSummary,
} from "./Skill";

export interface RegisteredSkill {
  readonly name: string;
  readonly description: string;
  readonly requiredCapabilities: readonly string[];
  readonly requiredQueries: readonly string[];
  readonly filePath: string;
}

export class SkillRegistry {
  private constructor(
    readonly rootPath: string,
    private readonly skills: ReadonlyMap<string, RegisteredSkill>,
  ) {}

  static async discover(rootPath: string): Promise<SkillRegistry> {
    const canonicalRoot = await realpath(rootPath);
    const entries = await readdir(canonicalRoot, { withFileTypes: true });
    const skills = new Map<string, RegisteredSkill>();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const filePath = join(canonicalRoot, entry.name, "SKILL.md");
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch (error: unknown) {
        if (isMissingFile(error)) continue;
        throw error;
      }

      const parsed = parseSkillDocument(content, filePath);
      if (parsed.name !== basename(entry.name)) {
        throw new Error(
          `Skill directory "${entry.name}" must match manifest name "${parsed.name}".`,
        );
      }
      if (skills.has(parsed.name)) {
        throw new Error(`Duplicate skill "${parsed.name}".`);
      }

      skills.set(parsed.name, {
        name: parsed.name,
        description: parsed.description,
        requiredCapabilities: [...parsed.requiredCapabilities],
        requiredQueries: [...parsed.requiredQueries],
        filePath,
      });
    }

    return new SkillRegistry(canonicalRoot, skills);
  }

  list(): readonly SkillSummary[] {
    return [...this.skills.values()]
      .map(({ name, description }) => ({ name, description }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  get(name: string): RegisteredSkill | undefined {
    const skill = this.skills.get(name);
    return skill
      ? {
          ...skill,
          requiredCapabilities: [...skill.requiredCapabilities],
          requiredQueries: [...skill.requiredQueries],
        }
      : undefined;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
