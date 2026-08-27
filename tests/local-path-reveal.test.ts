import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isInsideWorkspaces, resolveRevealTarget } from "../src/server/local-path-reveal.ts";

test("isInsideWorkspaces accepts exact roots and nested paths with case and separator tolerance", () => {
  const roots = ["D:\\Projects\\Orbit"];
  assert.equal(isInsideWorkspaces("D:/projects/orbit", roots), true);
  assert.equal(isInsideWorkspaces("d:\\projects\\orbit\\src\\ui", roots), true);
  assert.equal(isInsideWorkspaces("D:/projects/orbit/", roots), true);
  assert.equal(isInsideWorkspaces("D:/projects/orbit-other", roots), false, "prefix without separator must not match");
  assert.equal(isInsideWorkspaces("E:/elsewhere", roots), false);
  assert.equal(isInsideWorkspaces("D:/projects/orbit", []), false, "no configured roots means nothing is allowed");
});

test("resolveRevealTarget resolves files inside a configured workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-"));
  try {
    const file = path.join(root, "styles.css");
    fs.writeFileSync(file, "body {}");
    const result = await resolveRevealTarget(file, [root]);
    assert.ok(result.ok);
    assert.equal(result.target, fs.realpathSync(file));
    assert.equal(result.isDirectory, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRevealTarget strips :line suffixes so source references still resolve", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-"));
  try {
    const file = path.join(root, "App.tsx");
    fs.writeFileSync(file, "export {}");
    const result = await resolveRevealTarget(`${file}:5127`, [root]);
    assert.ok(result.ok);
    assert.equal(result.target, fs.realpathSync(file));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRevealTarget resolves directories", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-"));
  try {
    const dir = path.join(root, "src");
    fs.mkdirSync(dir);
    const result = await resolveRevealTarget(dir, [root]);
    assert.ok(result.ok);
    assert.equal(result.isDirectory, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRevealTarget rejects paths outside every configured workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-outside-"));
  try {
    const file = path.join(outside, "secret.txt");
    fs.writeFileSync(file, "x");
    const result = await resolveRevealTarget(file, [root]);
    assert.ok(!result.ok);
    assert.equal(result.status, 403);
    assert.ok(result.message.includes("工作区"), `expected workspace denial message in: ${result.message}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveRevealTarget reports missing paths as 404", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-"));
  try {
    const result = await resolveRevealTarget(path.join(root, "missing.txt:12"), [root]);
    assert.ok(!result.ok);
    assert.equal(result.status, 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRevealTarget expands ~ against the user home directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-"));
  t.mock.method(os, "homedir", () => root);
  try {
    const file = path.join(root, "notes.md");
    fs.writeFileSync(file, "note");
    const result = await resolveRevealTarget("~/notes.md", [root]);
    assert.ok(result.ok);
    assert.equal(result.target, fs.realpathSync(file));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRevealTarget rejects empty input", async () => {
  const result = await resolveRevealTarget("   ", []);
  assert.ok(!result.ok);
  assert.equal(result.status, 400);
});
