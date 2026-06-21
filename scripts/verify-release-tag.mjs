#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const expectedTag = `v${packageJson.version}`;

if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error(`Invalid release tag "${tag}". Expected v<major>.<minor>.<patch>.`);
  process.exit(1);
}

if (tag !== expectedTag) {
  console.error(`Release tag ${tag} does not match package.json version ${packageJson.version}. Expected ${expectedTag}.`);
  process.exit(1);
}

console.log(`Release tag ${tag} matches package.json version ${packageJson.version}.`);
