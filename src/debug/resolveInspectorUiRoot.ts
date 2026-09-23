import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve inspector static files for both `ts-node src/...` and `node dist/...`.
 */
export function resolveInspectorUiRoot(
  cwd: string = process.cwd(),
): string {
  const candidates = [
    join(cwd, "src", "debug", "ui"),
    join(cwd, "dist", "debug", "ui"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      return candidate;
    }
  }
  throw new Error(
    `Inspector UI assets not found. Looked in: ${candidates.join(", ")}`,
  );
}
