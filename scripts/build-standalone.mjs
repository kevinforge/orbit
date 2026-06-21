#!/usr/bin/env node
/**
 * Build Orbit as a standalone executable using Bun's compile feature.
 *
 * This produces a self-contained binary with embedded Bun runtime and
 * bytecode-compiled JavaScript for source protection.
 *
 * Usage:
 *   node scripts/build-standalone.mjs            # Build for current platform
 *   node scripts/build-standalone.mjs --all      # Build for all platforms
 *   node scripts/build-standalone.mjs --platform=windows
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Check if Bun is available
function hasBun() {
  try {
    execSync("bun --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Platform mapping
const PLATFORMS = {
  windows:  { target: "bun-windows-x64",   ext: ".exe" },
  linux:    { target: "bun-linux-x64",     ext: "" },
  macos:    { target: "bun-darwin-x64",    ext: "" },
  macosArm: { target: "bun-darwin-arm64",  ext: "" },
};

function getCurrentPlatform() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  if (platform === "darwin") {
    return arch === "arm64" ? "macosArm" : "macos";
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

function buildStandalone(platformKey) {
  const platform = PLATFORMS[platformKey];
  if (!platform) {
    throw new Error(`Unknown platform: ${platformKey}`);
  }

  const outfile = path.join(root, "dist", "bin", `orbit${platform.ext}`);

  console.log(`\n🔨 Building standalone binary for ${platformKey}...`);
  console.log(`   Target: ${platform.target}`);
  console.log(`   Output: ${outfile}`);

  // Ensure output directory exists
  const outDir = path.dirname(outfile);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Build the standalone executable with Bun
  const args = [
    "build",
    path.join(root, "src", "standalone-entry.ts"),
    "--compile",
    "--bytecode",
    "--minify",
    "--sourcemap=none",
    `--target=${platform.target}`,
    `--outfile=${outfile}`,
    "--define:process.env.ORBIT_STANDALONE=true",
  ];

  const result = spawnSync("bun", args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    throw new Error(`Bun build failed for ${platformKey}`);
  }

  // Bun compile can leave an entry-point source map next to the executable
  // even when --sourcemap=none is set. Release packages must never include it.
  for (const filename of fs.readdirSync(outDir)) {
    if (filename.endsWith(".map")) {
      fs.rmSync(path.join(outDir, filename));
    }
  }

  console.log(`✅ Built: ${outfile}`);

  const stats = fs.statSync(outfile);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
  console.log(`   Size: ${sizeMB} MB`);

  return outfile;
}

function buildAllPlatforms() {
  console.log("Building for all platforms...");
  const results = [];
  for (const platformKey of Object.keys(PLATFORMS)) {
    try {
      const outfile = buildStandalone(platformKey);
      results.push({ platform: platformKey, outfile, success: true });
    } catch (error) {
      results.push({
        platform: platformKey,
        error: error.message,
        success: false,
      });
    }
  }
  return results;
}

function main() {
  const args = process.argv.slice(2);

  // Check for Bun
  if (!hasBun()) {
    console.error("❌ Error: Bun is required to build standalone executables.");
    console.error("   Install Bun: https://bun.sh/docs/installation");
    process.exit(1);
  }

  // Parse arguments
  let buildAll = false;
  let targetPlatform = null;

  for (const arg of args) {
    if (arg === "--all") {
      buildAll = true;
    } else if (arg.startsWith("--platform=")) {
      targetPlatform = arg.split("=")[1];
    }
  }

  try {
    if (buildAll) {
      const results = buildAllPlatforms();
      console.log("\n📦 Build Summary:");
      for (const r of results) {
        if (r.success) {
          console.log(`   ✅ ${r.platform}: ${r.outfile}`);
        } else {
          console.log(`   ❌ ${r.platform}: ${r.error}`);
        }
      }
    } else if (targetPlatform) {
      buildStandalone(targetPlatform);
    } else {
      const platformKey = getCurrentPlatform();
      buildStandalone(platformKey);
    }

    console.log("\n🎉 Standalone build complete!");
    console.log("\n📋 Distribution:");
    console.log("   Copy the binary and UI assets together:");
    console.log("   - dist/bin/orbit (standalone binary)");
    console.log("   - dist/ui/ (UI assets folder)");
    console.log("\n📖 See docs/standalone-build.md for detailed instructions.");
  } catch (error) {
    console.error(`\n❌ Build failed: ${error.message}`);
    process.exit(1);
  }
}

main();
