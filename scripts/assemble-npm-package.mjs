#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.resolve(process.argv[2] ?? path.join(root, "release-assets"));
const distDir = path.join(root, "dist");
const binDir = path.join(distDir, "bin");
const uiDir = path.join(distDir, "ui");

const expectedAssets = new Map([
  ["windows-x64", "orbit.exe"],
  ["linux-x64", "orbit"],
  ["macos-x64", "orbit"],
  ["macos-arm64", "orbit"],
]);

function runTar(args, cwd) {
  const result = spawnSync("tar", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function copyBinary(extractDir, asset, binaryName) {
  const src = path.join(extractDir, "package", "dist", "bin", binaryName);
  const destDir = path.join(binDir, asset);
  const dest = path.join(destDir, binaryName);

  if (!fs.existsSync(src)) {
    throw new Error(`Missing ${binaryName} in ${asset} package.`);
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  if (binaryName === "orbit") {
    fs.chmodSync(dest, 0o755);
  }
}

function copyUiOnce(extractDir) {
  const src = path.join(extractDir, "package", "dist", "ui");
  if (!fs.existsSync(src)) {
    throw new Error("Missing dist/ui in release package.");
  }
  if (!fs.existsSync(uiDir)) {
    fs.cpSync(src, uiDir, { recursive: true });
  }
}

function main() {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Release assets directory not found: ${sourceDir}`);
  }

  fs.rmSync(binDir, { recursive: true, force: true });
  fs.rmSync(uiDir, { recursive: true, force: true });

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-npm-"));
  const found = new Set();

  try {
    for (const [asset, binaryName] of expectedAssets) {
      const archive = fs.readdirSync(sourceDir).find((name) => name.endsWith(`-${asset}.tgz`));
      if (!archive) {
        throw new Error(`Missing release package for ${asset}.`);
      }

      const extractDir = path.join(tempRoot, asset);
      fs.mkdirSync(extractDir, { recursive: true });
      runTar(["-xzf", path.join(sourceDir, archive), "-C", extractDir], root);
      copyBinary(extractDir, asset, binaryName);
      copyUiOnce(extractDir);
      found.add(asset);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  if (found.size !== expectedAssets.size) {
    throw new Error("Not all platform release packages were assembled.");
  }

  console.log(`Assembled npm package payload from ${sourceDir}`);
}

main();
