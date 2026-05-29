import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TerminalTranscriptStore } from "../src/core/terminal-transcript-store.ts";

test("appends cleaned terminal chunks by agent", () => {
  const store = new TerminalTranscriptStore();

  store.append("agent1", "\u001b[32mhello\u001b[0m");
  store.append("agent1", "\nworld");
  store.append("agent2", "other");

  assert.equal(store.get("agent1"), "hello\nworld");
  assert.equal(store.get("agent2"), "other");
});

test("list returns terminal snapshots for agents that produced output", () => {
  const store = new TerminalTranscriptStore();
  store.append("developer", "one");

  assert.deepEqual(store.list(), {
    developer: "one",
  });
});

test("unknown agent transcript starts empty", () => {
  const store = new TerminalTranscriptStore();

  assert.equal(store.get("tester"), "");
});

test("persisted store round-trips transcripts to directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  try {
    const store = new TerminalTranscriptStore(dir);
    store.append("developer", "output A");
    store.append("architect", "output B");

    const loaded = new TerminalTranscriptStore(dir);
    assert.equal(loaded.get("developer"), "output A");
    assert.equal(loaded.get("architect"), "output B");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted store appends to existing transcripts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  try {
    const store = new TerminalTranscriptStore(dir);
    store.append("developer", "part1 ");

    const loaded = new TerminalTranscriptStore(dir);
    loaded.append("developer", "part2");

    assert.equal(loaded.get("developer"), "part1 part2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted store survives Windows rename failures while saving transcript chunks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const originalRenameSync = fs.renameSync;
  try {
    fs.renameSync = (() => {
      const error = new Error("operation not permitted, rename") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }) as typeof fs.renameSync;

    const store = new TerminalTranscriptStore(dir);
    assert.doesNotThrow(() => store.append("ux", "output"));
    assert.equal(store.get("ux"), "output");

    const loaded = new TerminalTranscriptStore(dir);
    assert.equal(loaded.get("ux"), "output");
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted store queues transcript chunks and retries after the log file is busy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const originalAppendFileSync = fs.appendFileSync;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  let attempts = 0;
  try {
    fs.appendFileSync = ((...args: Parameters<typeof fs.appendFileSync>) => {
      attempts += 1;
      if (attempts <= 2) {
        const error = new Error("resource busy or locked") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return originalAppendFileSync(...args);
    }) as typeof fs.appendFileSync;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    const store = new TerminalTranscriptStore(dir);
    assert.doesNotThrow(() => store.append("ux", "first "));
    assert.doesNotThrow(() => store.append("ux", "second"));
    assert.equal(store.get("ux"), "first second");

    await new Promise((resolve) => setTimeout(resolve, 150));

    const loaded = new TerminalTranscriptStore(dir);
    assert.equal(loaded.get("ux"), "first second");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /failed to persist terminal transcript for ux/);
  } finally {
    fs.appendFileSync = originalAppendFileSync;
    console.warn = originalWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted store strips ANSI before saving", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  try {
    const store = new TerminalTranscriptStore(dir);
    store.append("developer", "[32mhello[0m");

    const loaded = new TerminalTranscriptStore(dir);
    assert.equal(loaded.get("developer"), "hello");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("different directories keep transcripts isolated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const dirA = path.join(dir, "a");
  const dirB = path.join(dir, "b");
  try {
    const storeA = new TerminalTranscriptStore(dirA);
    const storeB = new TerminalTranscriptStore(dirB);
    storeA.append("developer", "workspace A");
    storeB.append("developer", "workspace B");

    const loadedA = new TerminalTranscriptStore(dirA);
    const loadedB = new TerminalTranscriptStore(dirB);
    assert.equal(loadedA.get("developer"), "workspace A");
    assert.equal(loadedB.get("developer"), "workspace B");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted store ignores non-log files in directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "readme.txt"), "ignore me");
    const store = new TerminalTranscriptStore(dir);
    assert.equal(store.get("readme"), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
