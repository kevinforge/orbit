#!/usr/bin/env node
// Orbit - local-first chat control surface for coding agents.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const serverEntry = path.join(root, "dist", "server", "index.js");

const child = spawn(process.execPath, [serverEntry], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: {
    ...process.env,
    ORBIT_DIST_UI: path.join(root, "dist", "ui"),
  },
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
