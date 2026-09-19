import { parse } from "yaml";
import { z } from "zod";

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
}

export interface LoadedSkill extends SkillSummary {
  readonly requiredCapabilities: readonly string[];
  readonly requiredQueries: readonly string[];
  readonly instructions: string;
}

export interface ParsedSkill extends LoadedSkill {}

const skillFrontmatterSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "Invalid skill name."),
    description: z.string().trim().min(1),
    required_capabilities: z.array(z.string().trim().min(1)),
    required_queries: z.array(z.string().trim().min(1)),
  })
  .strict();

export function parseSkillDocument(
  content: string,
  source: string,
): ParsedSkill {
  const match =
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/.exec(content);
  if (!match) {
    throw new Error(`Skill "${source}" has no valid YAML frontmatter.`);
  }

  let rawFrontmatter: unknown;
  try {
    rawFrontmatter = parse(match[1]!);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Skill "${source}" has invalid YAML: ${message}`);
  }

  const frontmatter = skillFrontmatterSchema.safeParse(rawFrontmatter);
  if (!frontmatter.success) {
    throw new Error(
      `Skill "${source}" has invalid frontmatter: ${frontmatter.error.message}`,
    );
  }

  const instructions = match[2]!.trim();
  if (!instructions) {
    throw new Error(`Skill "${source}" has no instructions.`);
  }

  return {
    name: frontmatter.data.name,
    description: frontmatter.data.description,
    requiredCapabilities: [...frontmatter.data.required_capabilities],
    requiredQueries: [...frontmatter.data.required_queries],
    instructions,
  };
}
