const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

function collectTests(directory) {
  const tests = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...collectTests(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      tests.push(path);
    }
  }

  return tests.sort();
}

const requestedDirectory = process.argv[2] ?? "tests/unit";
const tests = collectTests(join(process.cwd(), requestedDirectory));
if (tests.length === 0) {
  console.error(`No TypeScript test files were found in ${requestedDirectory}.`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["-r", "ts-node/register", "--test", ...tests],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
