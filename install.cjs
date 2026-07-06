#!/usr/bin/env node
// Orbit postinstall script.
//
// Detects the current platform and copies the matching standalone binary into
// bin/orbit so the package.json "bin" entry can exec the native binary.

const { spawnSync } = require("child_process");
const { chmodSync, copyFileSync, existsSync } = require("fs");
const { arch, platform } = require("os");
const path = require("path");

const PLATFORMS = {
  "win32-x64": { asset: "windows-x64", source: "orbit.exe", target: "orbit.exe" },
  "darwin-x64": { asset: "macos-x64", source: "orbit", target: "orbit" },
  "darwin-arm64": { asset: "macos-arm64", source: "orbit", target: "orbit" },
  "linux-x64": { asset: "linux-x64", source: "orbit", target: "orbit" },
};

function getPlatformKey() {
  let cpu = arch();
  const plat = platform();

  if (plat === "darwin" && cpu === "x64") {
    const result = spawnSync("sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8" });
    if (result.stdout?.trim() === "1") cpu = "arm64";
  }

  return `${plat}-${cpu}`;
}

function main() {
  const key = getPlatformKey();
  const info = PLATFORMS[key];

  if (!info) {
    console.warn(`[orbit postinstall] Unsupported platform: ${key}`);
    console.warn("  The `orbit` command will fall back to development mode.");
    return;
  }

  const src = [
    path.join(__dirname, "dist", "bin", info.asset, info.source),
    path.join(__dirname, "dist", "bin", info.source),
  ].find((candidate) => existsSync(candidate));
  const dest = path.join(__dirname, "bin", info.target);

  if (!src) {
    console.warn(`[orbit postinstall] Binary not found for ${key}`);
    console.warn("  Run `npm run build` first, or use `npm run dev` for development.");
    return;
  }

  try {
    copyFileSync(src, dest);
    if (process.platform !== "win32") {
      chmodSync(dest, 0o755);
    }
  } catch (err) {
    console.error(`[orbit postinstall] Failed to place binary: ${err.message}`);
    console.error("  Fallback: the bin/orbit.js launcher will use development mode.");
  }
}

main();
