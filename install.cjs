#!/usr/bin/env node
// Orbit postinstall script.
//
// Detects platform and copies the matching standalone binary into bin/orbit
// so the package.json "bin" entry execs the native binary directly.
//
// Platform detection mirrors scripts/build-standalone.mjs — keep in sync.

const { spawnSync } = require('child_process');
const { copyFileSync, unlinkSync, chmodSync, statSync } = require('fs');
const { arch, platform } = require('os');
const path = require('path');

const PLATFORMS = {
  'win32-x64': { source: 'orbit.exe', target: 'orbit.exe' },
  'darwin-x64': { source: 'orbit', target: 'orbit' },
  'darwin-arm64': { source: 'orbit', target: 'orbit' },
  'linux-x64': { source: 'orbit', target: 'orbit' },
};

function getPlatformKey() {
  let cpu = arch();
  const plat = platform();

  // Rosetta 2 detection
  if (plat === 'darwin' && cpu === 'x64') {
    const r = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' });
    if (r.stdout?.trim() === '1') cpu = 'arm64';
  }

  return plat + '-' + cpu;
}

function main() {
  const key = getPlatformKey();
  const info = PLATFORMS[key];

  if (!info) {
    console.warn(`[orbit postinstall] Unsupported platform: ${key}`);
    console.warn('  The `orbit` command will fall back to development mode.');
    return;
  }

  const src = path.join(__dirname, 'dist', 'bin', info.source);
  const dest = path.join(__dirname, 'bin', info.target);

  if (!require('fs').existsSync(src)) {
    console.warn(`[orbit postinstall] Binary not found at ${src}`);
    console.warn('  Run `npm run build` first, or use `npm run dev` for development.');
    return;
  }

  try {
    copyFileSync(src, dest);
    if (process.platform !== 'win32') {
      chmodSync(dest, 0o755);
    }
  } catch (err) {
    console.error(`[orbit postinstall] Failed to place binary: ${err.message}`);
    console.error('  Fallback: the bin/orbit.js launcher will use development mode.');
  }
}

main();
