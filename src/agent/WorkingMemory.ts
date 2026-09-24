export class WorkingMemory {
  private text = "";

  constructor(readonly maxLength: number) {
    if (!Number.isInteger(maxLength) || maxLength < 1) {
      throw new Error("Working memory maxLength must be a positive integer.");
    }
  }

  read(): string {
    return this.text;
  }

  replace(next: string): void {
    if (typeof next !== "string") {
      throw new Error("Working memory must be a string.");
    }
    const normalized = next.trim();
    if (normalized.length > this.maxLength) {
      throw new Error(
        `Working memory exceeds ${this.maxLength} characters.`,
      );
    }
    this.text = normalized;
  }

  clear(): void {
    this.text = "";
  }
}
