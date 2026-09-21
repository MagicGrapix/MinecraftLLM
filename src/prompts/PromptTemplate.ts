import { readFile } from "node:fs/promises";

export type PromptValues = Readonly<Record<string, unknown>>;

const PLACEHOLDER = /{{\s*([a-zA-Z][a-zA-Z0-9_.-]*)\s*}}/g;

export class PromptTemplate {
  private constructor(
    readonly sourcePath: string,
    private readonly source: string,
  ) {}

  static async load(filePath: string): Promise<PromptTemplate> {
    const source = (await readFile(filePath, "utf8")).trim();
    if (!source) {
      throw new Error(`Prompt template "${filePath}" is empty.`);
    }
    return new PromptTemplate(filePath, source);
  }

  static fromString(name: string, source: string): PromptTemplate {
    if (!source.trim()) {
      throw new Error(`Prompt template "${name}" is empty.`);
    }
    return new PromptTemplate(name, source.trim());
  }

  render(values: PromptValues = {}): string {
    return this.source.replace(
      PLACEHOLDER,
      (_match, rawName: string) => {
        const name = rawName.trim();
        if (!Object.prototype.hasOwnProperty.call(values, name)) {
          throw new Error(
            `Prompt template "${this.sourcePath}" is missing value "${name}".`,
          );
        }
        const value = values[name];
        if (value === undefined) {
          throw new Error(
            `Prompt value "${name}" is undefined in "${this.sourcePath}".`,
          );
        }
        return typeof value === "string"
          ? value
          : JSON.stringify(value);
      },
    );
  }
}

