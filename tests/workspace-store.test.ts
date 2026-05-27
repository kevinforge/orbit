import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceStore } from "../src/core/workspace-store.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-workspace-test-"));
}

test("deriveId returns deterministic short hash from cwd", () => {
  const id = WorkspaceStore.deriveId("/home/user/projects/my-app");
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(id, WorkspaceStore.deriveId("/home/user/projects/my-app"));
});

test("different cwds produce different ids", () => {
  const a = WorkspaceStore.deriveId("/home/user/projects/a");
  const b = WorkspaceStore.deriveId("/home/user/projects/b");
  assert.notEqual(a, b);
});

test("deriveId is case-insensitive on win32, case-sensitive elsewhere; normalizes trailing slashes", () => {
  if (process.platform === "win32") {
    assert.equal(WorkspaceStore.deriveId("C:\\Projects\\App"), WorkspaceStore.deriveId("c:\\projects\\app"));
  } else {
    assert.notEqual(WorkspaceStore.deriveId("/home/user/projects/App"), WorkspaceStore.deriveId("/home/user/projects/app"));
  }
  assert.equal(WorkspaceStore.deriveId("/home/user/projects/app/"), WorkspaceStore.deriveId("/home/user/projects/app"));
});

test("resolve returns workspace info from existing metadata file", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const cwd = "/home/user/projects/orbit";

  const workspace = store.resolve(cwd);
  assert.ok(workspace.id);
  assert.equal(workspace.path, cwd);
  assert.equal(workspace.name, "orbit");
  assert.ok(fs.existsSync(path.join(dir, workspace.id, "workspace.json")));
});

test("resolve creates workspace directory and metadata on first call", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);

  const workspace = store.resolve("/home/user/projects/new-project");

  const metadataPath = path.join(dir, workspace.id, "workspace.json");
  assert.ok(fs.existsSync(metadataPath));
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.id, workspace.id);
  assert.equal(metadata.path, "/home/user/projects/new-project");
  assert.equal(metadata.name, "new-project");
  assert.ok(metadata.createdAt, "metadata should include createdAt");
  assert.ok(new Date(metadata.createdAt).getTime() > 0, "createdAt should be a valid ISO date");
  assert.equal(metadata.lastOpenedAt, metadata.createdAt, "lastOpenedAt should equal createdAt on first creation");
});

test("resolve loads existing workspace and updates lastOpenedAt", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const cwd = "/home/user/projects/existing";

  const first = store.resolve(cwd);
  const metadataPath = path.join(dir, first.id, "workspace.json");
  const firstMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

  // Small delay to ensure different timestamp
  const start = Date.now();
  while (Date.now() === start) { /* spin */ }

  const second = store.resolve(cwd);
  const secondMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

  assert.equal(first.id, second.id);
  assert.equal(first.name, second.name);
  assert.equal(secondMetadata.createdAt, firstMetadata.createdAt, "createdAt should not change");
  assert.notEqual(secondMetadata.lastOpenedAt, firstMetadata.lastOpenedAt, "lastOpenedAt should update on re-open");
});

test("sessionsDir returns workspace sessions path", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const workspace = store.resolve("/home/user/projects/test");

  const sessionsDir = store.sessionsDir(workspace.id);
  assert.equal(sessionsDir, path.join(dir, workspace.id, "sessions"));
});

test("name defaults to last path segment", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const workspace = store.resolve("/home/user/My Cool Project");

  assert.equal(workspace.name, "My Cool Project");
});

test("sessionsDir returns path under workspace base", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const id = WorkspaceStore.deriveId(process.cwd());

  assert.equal(store.sessionsDir(id), path.join(dir, id, "sessions"));
});

test("dataDir returns workspace data path", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const ws = store.resolve("/tmp/project-data");
  const dataDir = store.dataDir(ws.id);
  assert.equal(dataDir, path.join(dir, ws.id, "data"));
});
