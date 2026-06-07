#!/usr/bin/env node
// Orbit - local-first chat control surface for coding agents.
//
// Resolution order:
//   1. bin/orbit (native binary placed by `npm install -g` → postinstall)
//   2. dist/bin/orbit (build output directory)
//   3. npx tsx src/server/index.ts (development fallback)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const ext = process.platform === "win32" ? ".exe" : "";
const binaryName = `orbit${ext}`;

// Priority 1: bin/orbit (placed by postinstall during npm install -g)
const binBinary = path.join(__dirname, binaryName);
// Priority 2: dist/bin/orbit (build output)
const distBinary = path.join(root, "dist", "bin", binaryName);

const binary = fs.existsSync(binBinary) ? binBinary
  : fs.existsSync(distBinary) ? distBinary
  : null;

if (binary) {
  spawn(binary, process.argv.slice(2), {
    stdio: "inherit",
    cwd: process.cwd(),
    env: {
      ...process.env,
      ORBIT_UI_DIR: process.env.ORBIT_UI_DIR ?? path.join(root, "dist", "ui"),
    },
  }).on("exit", (code) => process.exit(code ?? 1));
} else {
  // Fallback: development mode
  console.error("orbit: standalone binary not found. Run `npm run build` to create it.");
  // On Windows, npx needs .cmd suffix for correct execution
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  spawn(npx, ["tsx", path.join(root, "src", "server", "index.ts")], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: {
      ...process.env,
      ORBIT_DIST_UI: path.join(root, "dist", "ui"),
    },
  }).on("exit", (code) => process.exit(code ?? 1));
}
