const { cpSync, mkdirSync } = require("node:fs");
const { dirname, join } = require("node:path");

const source = join(__dirname, "..", "src", "debug", "ui");
const target = join(__dirname, "..", "dist", "debug", "ui");

mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
console.info(`Copied inspector UI from ${source} to ${target}`);
