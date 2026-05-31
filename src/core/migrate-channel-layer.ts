import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE_DIR = path.join(os.homedir(), ".orbit");

/**
 * One-time migration: flatten the hardcoded "default/" directory layer
 * and rename "channels/" to "conversations/".
 */
export function migrateChannelLayer(): void {
  // 1. Flatten "default/" in sessions
  flattenDefaultDirs(path.join(BASE_DIR, "sessions"));

  // 2. Flatten "default/" in transcripts
  flattenDefaultDirs(path.join(BASE_DIR, "transcripts"));

  // 3. Flatten "default/" in channels, then rename channels → conversations
  flattenDefaultDirs(path.join(BASE_DIR, "channels"));
  renameDir(path.join(BASE_DIR, "channels"), path.join(BASE_DIR, "conversations"));
}

function flattenDefaultDirs(parentDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(parentDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(parentDir, entry);
    if (!fs.statSync(entryPath).isDirectory()) continue;

    // For sessions, there's a runtime subdirectory (e.g., "claude-code")
    const subEntries = fs.readdirSync(entryPath);
    for (const sub of subEntries) {
      const subPath = path.join(entryPath, sub);
      if (!fs.statSync(subPath).isDirectory()) continue;

      const defaultDir = path.join(subPath, "default");
      if (isDir(defaultDir)) {
        moveChildrenUp(defaultDir, subPath);
        rmDir(defaultDir);
      }
    }

    // Also check for a direct "default" child (e.g., channels/{wsId}/default/)
    const directDefault = path.join(entryPath, "default");
    if (isDir(directDefault)) {
      moveChildrenUp(directDefault, entryPath);
      rmDir(directDefault);
    }
  }
}

function moveChildrenUp(srcDir: string, destDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(srcDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const src = path.join(srcDir, entry);
    const dest = path.join(destDir, entry);
    if (fs.existsSync(dest)) continue;
    try {
      fs.renameSync(src, dest);
    } catch {
      // cross-device or other issue, skip
    }
  }
}

function renameDir(oldPath: string, newPath: string): void {
  if (!isDir(oldPath)) return;
  if (isDir(newPath)) return; // already migrated
  try {
    fs.renameSync(oldPath, newPath);
  } catch {
    // skip on failure
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function rmDir(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
