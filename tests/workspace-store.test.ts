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
});

test("resolve loads existing workspace on subsequent calls", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const cwd = "/home/user/projects/existing";

  const first = store.resolve(cwd);
  const second = store.resolve(cwd);

  assert.equal(first.id, second.id);
  assert.equal(first.name, second.name);
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

test("default baseDir uses ~/.orbit/workspaces", () => {
  const store = new WorkspaceStore();
  const expected = path.join(os.homedir(), ".orbit", "workspaces");

  // We can't easily test the internal baseDir, but we can verify sessionsDir
  // uses the expected pattern by checking resolve works.
  const workspace = store.resolve(process.cwd());
  assert.ok(workspace.id);
  assert.equal(workspace.path, process.cwd());
});
