#!/usr/bin/env node
// Orbit — local-first chat control surface for Claude Code agents.
// Uses tsx to run the TypeScript server entry.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const isWin = process.platform === "win32";
const tsxBin = path.join(root, "node_modules", ".bin", isWin ? "tsx.cmd" : "tsx");
const serverEntry = path.join(root, "src", "server", "index.ts");

const child = spawn(tsxBin, [serverEntry], {
  stdio: "inherit",
  cwd: process.cwd(),
  shell: isWin,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
