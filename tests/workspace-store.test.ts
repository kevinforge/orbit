import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceStore } from "../src/core/workspace-store.ts";
import type { Workspace } from "../src/shared/types.ts";

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
  assert.equal(workspace.path, path.resolve(cwd));
  assert.equal(workspace.name, "orbit");
  assert.ok(fs.existsSync(path.join(dir, "workspaces", workspace.id, "workspace.json")));
});

test("resolve creates workspace directory and metadata on first call", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);

  const workspace = store.resolve("/home/user/projects/new-project");

  const metadataPath = path.join(dir, "workspaces", workspace.id, "workspace.json");
  assert.ok(fs.existsSync(metadataPath));
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.id, workspace.id);
  assert.equal(metadata.path, path.resolve("/home/user/projects/new-project"));
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
  const metadataPath = path.join(dir, "workspaces", first.id, "workspace.json");
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
  assert.equal(sessionsDir, path.join(dir, "sessions", workspace.id));
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

  assert.equal(store.sessionsDir(id), path.join(dir, "sessions", id));
});

test("dataDir returns workspace data path", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const ws = store.resolve("/tmp/project-data");
  const dataDir = store.dataDir(ws.id);
  assert.equal(dataDir, path.join(dir, "data", ws.id));
});

test("channelsDir returns path with workspace, channel and conversation", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const ws = store.resolve("/tmp/project-channels");

  assert.equal(
    store.channelsDir(ws.id, "general", "conv-1"),
    path.join(dir, "channels", ws.id, "general", "conv-1"),
  );
});

test("channelsDir defaults to 'default' for channel and conversation", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const ws = store.resolve("/tmp/project-defaults");

  assert.equal(store.channelsDir(ws.id), path.join(dir, "channels", ws.id, "default", "default"));
});

test("transcriptsDir returns path with workspace, channel and conversation", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const ws = store.resolve("/tmp/project-transcripts");

  assert.equal(
    store.transcriptsDir(ws.id, "general", "conv-1"),
    path.join(dir, "transcripts", ws.id, "general", "conv-1"),
  );
});

test("transcriptsDir defaults to 'default' for channel and conversation", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const ws = store.resolve("/tmp/project-defaults");

  assert.equal(store.transcriptsDir(ws.id), path.join(dir, "transcripts", ws.id, "default", "default"));
});

// --- New CRUD tests ---

test("list returns all workspaces in stable creation order", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const ws1 = store.resolve("/projects/alpha");
  const ws2 = store.resolve("/projects/beta");

  store.touchLastOpened(ws2.id);

  const list = store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, ws1.id, "clicking/opening should not move a workspace");
  assert.equal(list[1].id, ws2.id);
});

test("get returns workspace by id", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const ws = store.resolve("/projects/my-app");

  const result = store.get(ws.id);
  assert.ok(result);
  assert.equal(result!.id, ws.id);
  assert.equal(result!.name, ws.name);
  assert.ok(result!.createdAt);
  assert.ok(result!.lastOpenedAt);
});

test("get returns null for unknown id", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  assert.equal(store.get("nonexistent"), null);
});

test("create creates a new workspace", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const ws = store.create("My Project", "/projects/my-project");

  assert.ok(ws.id);
  assert.equal(ws.name, "My Project");
  assert.equal(ws.path, path.resolve("/projects/my-project"));
  assert.ok(ws.createdAt);
  assert.ok(ws.lastOpenedAt);
  assert.ok(store.get(ws.id));
});

test("create throws if workspace already exists for path", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  store.create("First", "/projects/same-path");

  assert.throws(() => store.create("Second", "/projects/same-path"), /already exists/);
});

test("update renames a workspace", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const ws = store.create("Old Name", "/projects/rename-me");

  const updated = store.update(ws.id, { name: "New Name" });
  assert.equal(updated.name, "New Name");

  const reloaded = store.get(ws.id);
  assert.equal(reloaded!.name, "New Name");
});

test("update throws for unknown id", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  assert.throws(() => store.update("nonexistent", { name: "X" }), /not found/);
});

test("delete removes workspace and all related directories", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const ws = store.create("ToDelete", "/projects/delete-me");

  // Create some related directories
  fs.mkdirSync(store.sessionsDir(ws.id), { recursive: true });
  fs.mkdirSync(store.channelsDir(ws.id), { recursive: true });
  fs.mkdirSync(store.transcriptsDir(ws.id), { recursive: true });

  store.delete(ws.id);

  assert.equal(store.get(ws.id), null);
  assert.ok(!fs.existsSync(path.join(dir, "workspaces", ws.id)));
  assert.ok(!fs.existsSync(store.sessionsDir(ws.id)));
  assert.ok(!fs.existsSync(store.channelsDir(ws.id)));
  assert.ok(!fs.existsSync(store.transcriptsDir(ws.id)));
});

test("delete throws for unknown id", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  assert.throws(() => store.delete("nonexistent"), /not found/);
});

test("touchLastOpened updates lastOpenedAt", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const ws = store.create("Touch", "/projects/touch");

  const before = store.get(ws.id)!;
  // Small delay to ensure different timestamp
  const start = Date.now();
  while (Date.now() === start) { /* spin */ }

  store.touchLastOpened(ws.id);
  const after = store.get(ws.id)!;

  assert.equal(before.id, after.id);
  assert.notEqual(after.lastOpenedAt, before.lastOpenedAt);
});

test("create normalizes relative paths to absolute paths", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const ws = store.create("Relative", "some/relative/path");

  assert.ok(path.isAbsolute(ws.path), `path should be absolute, got: ${ws.path}`);
  assert.ok(ws.path.includes("some" + path.sep + "relative" + path.sep + "path"));
});

test("resolve normalizes relative cwd to absolute path", () => {
  const dir = tmpDir();
  const store = new WorkspaceStore(dir);
  const ws = store.resolve("some/relative/project");

  assert.ok(path.isAbsolute(ws.path), `path should be absolute, got: ${ws.path}`);
});
