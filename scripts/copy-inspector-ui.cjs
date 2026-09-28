const { cpSync, mkdirSync } = require("node:fs");
const { dirname, join } = require("node:path");

const source = join(__dirname, "..", "src", "debug", "ui");
const target = join(__dirname, "..", "dist", "debug", "ui");

mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
console.info(`Copied inspector UI from ${source} to ${target}`);

const labSource = join(__dirname, "..", "src", "lab", "ui");
const labTarget = join(__dirname, "..", "dist", "lab", "ui");
mkdirSync(dirname(labTarget), { recursive: true });
cpSync(labSource, labTarget, { recursive: true });
console.info(`Copied prompt lab UI from ${labSource} to ${labTarget}`);
