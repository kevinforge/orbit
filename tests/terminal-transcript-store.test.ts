import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TerminalTranscriptStore } from "../src/core/terminal-transcript-store.ts";

function cleanupTranscriptTest(dir: string, stores: TerminalTranscriptStore[]): void {
  for (const store of stores) {
    store.dispose();
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

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
  const stores: TerminalTranscriptStore[] = [];
  try {
    const store = new TerminalTranscriptStore(dir);
    stores.push(store);
    store.append("developer", "output A");
    store.append("architect", "output B");

    const loaded = new TerminalTranscriptStore(dir);
    stores.push(loaded);
    assert.equal(loaded.get("developer"), "output A");
    assert.equal(loaded.get("architect"), "output B");
  } finally {
    cleanupTranscriptTest(dir, stores);
  }
});

test("persisted store rolls transcript segments by size", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const stores: TerminalTranscriptStore[] = [];
  try {
    const store = new TerminalTranscriptStore(dir, { maxSegmentBytes: 8, now: () => new Date("2026-01-02T10:00:00.000Z") });
    stores.push(store);

    store.append("developer", "1234");
    store.append("developer", "5678");
    store.append("developer", "90");

    const agentDir = path.join(dir, "developer");
    const segments = fs.readdirSync(agentDir).filter((entry) => entry.endsWith(".log")).sort();
    assert.deepEqual(segments, ["2026-01-02-0001.log", "2026-01-02-0002.log"]);
    assert.equal(fs.readFileSync(path.join(agentDir, segments[0]), "utf8"), "12345678");
    assert.equal(fs.readFileSync(path.join(agentDir, segments[1]), "utf8"), "90");
  } finally {
    cleanupTranscriptTest(dir, stores);
  }
});

test("persisted store loads only recent transcript tail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const stores: TerminalTranscriptStore[] = [];
  try {
    const agentDir = path.join(dir, "developer");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "2026-01-01-0001.log"), "older ");
    fs.writeFileSync(path.join(agentDir, "2026-01-01-0002.log"), "recent-tail");

    const store = new TerminalTranscriptStore(dir, { tailBytes: 6 });
    stores.push(store);

    assert.equal(store.get("developer"), "t-tail");
  } finally {
    cleanupTranscriptTest(dir, stores);
  }
});

test("persisted store merges legacy root logs with segmented transcript tail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const originalReadDirSync = fs.readdirSync;
  const stores: TerminalTranscriptStore[] = [];
  try {
    const agentDir = path.join(dir, "developer");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(dir, "developer.log"), "legacy ");
    fs.writeFileSync(path.join(agentDir, "2026-01-01-0001.log"), "segment");
    fs.readdirSync = ((target: fs.PathLike) => {
      if (String(target) === dir) {
        return ["developer.log", "developer"] as unknown as ReturnType<typeof fs.readdirSync>;
      }
      return originalReadDirSync(target);
    }) as typeof fs.readdirSync;

    const store = new TerminalTranscriptStore(dir);
    stores.push(store);

    assert.equal(store.get("developer"), "legacy segment");
  } finally {
    fs.readdirSync = originalReadDirSync;
    cleanupTranscriptTest(dir, stores);
  }
});

test("persisted store splits a single oversized transcript chunk across segments", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const stores: TerminalTranscriptStore[] = [];
  try {
    const store = new TerminalTranscriptStore(dir, { maxSegmentBytes: 5, now: () => new Date("2026-01-02T10:00:00.000Z") });
    stores.push(store);

    store.append("developer", "abcdefghijkl");

    const agentDir = path.join(dir, "developer");
    const segments = fs.readdirSync(agentDir).filter((entry) => entry.endsWith(".log")).sort();
    assert.deepEqual(segments, ["2026-01-02-0001.log", "2026-01-02-0002.log", "2026-01-02-0003.log"]);
    assert.deepEqual(
      segments.map((segment) => fs.readFileSync(path.join(agentDir, segment), "utf8")),
      ["abcde", "fghij", "kl"],
    );
  } finally {
    cleanupTranscriptTest(dir, stores);
  }
});

test("persisted store appends to existing transcripts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const stores: TerminalTranscriptStore[] = [];
  try {
    const store = new TerminalTranscriptStore(dir);
    stores.push(store);
    store.append("developer", "part1 ");

    const loaded = new TerminalTranscriptStore(dir);
    stores.push(loaded);
    loaded.append("developer", "part2");

    assert.equal(loaded.get("developer"), "part1 part2");
  } finally {
    cleanupTranscriptTest(dir, stores);
  }
});

test("persisted store survives Windows rename failures while saving transcript chunks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const originalRenameSync = fs.renameSync;
  const stores: TerminalTranscriptStore[] = [];
  try {
    fs.renameSync = (() => {
      const error = new Error("operation not permitted, rename") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }) as typeof fs.renameSync;

    const store = new TerminalTranscriptStore(dir);
    stores.push(store);
    assert.doesNotThrow(() => store.append("ux", "output"));
    assert.equal(store.get("ux"), "output");

    const loaded = new TerminalTranscriptStore(dir);
    stores.push(loaded);
    assert.equal(loaded.get("ux"), "output");
  } finally {
    fs.renameSync = originalRenameSync;
    cleanupTranscriptTest(dir, stores);
  }
});

test("persisted store retries busy writes without a separate pending buffer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const originalWriteSync = fs.writeSync;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  let attempts = 0;
  const stores: TerminalTranscriptStore[] = [];
  try {
    fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
      attempts += 1;
      if (attempts <= 2) {
        const error = new Error("resource busy or locked") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return originalWriteSync(...args);
    }) as typeof fs.writeSync;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    const store = new TerminalTranscriptStore(dir);
    stores.push(store);
    assert.doesNotThrow(() => store.append("ux", "first "));
    assert.doesNotThrow(() => store.append("ux", "second"));
    assert.equal(store.get("ux"), "first second");

    await new Promise((resolve) => setTimeout(resolve, 150));

    const loaded = new TerminalTranscriptStore(dir);
    stores.push(loaded);
    assert.equal(loaded.get("ux"), "first second");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /failed to persist terminal transcript for ux/);
  } finally {
    fs.writeSync = originalWriteSync;
    console.warn = originalWarn;
    cleanupTranscriptTest(dir, stores);
  }
});

test("persisted store keeps an append handle open for realtime log viewing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const originalOpenSync = fs.openSync;
  let openCount = 0;
  const stores: TerminalTranscriptStore[] = [];
  try {
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      openCount += 1;
      if (openCount > 1) {
        const error = new Error("resource busy or locked") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return originalOpenSync(...args);
    }) as typeof fs.openSync;

    const store = new TerminalTranscriptStore(dir);
    stores.push(store);
    store.append("ux", "first ");
    store.append("ux", "second");

    assert.equal(store.get("ux"), "first second");
    assert.equal(openCount, 1);

    fs.openSync = originalOpenSync;
    const loaded = new TerminalTranscriptStore(dir);
    stores.push(loaded);
    assert.equal(loaded.get("ux"), "first second");
  } finally {
    fs.openSync = originalOpenSync;
    cleanupTranscriptTest(dir, stores);
  }
});

test("persisted store strips ANSI before saving", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const stores: TerminalTranscriptStore[] = [];
  try {
    const store = new TerminalTranscriptStore(dir);
    stores.push(store);
    store.append("developer", "[32mhello[0m");

    const loaded = new TerminalTranscriptStore(dir);
    stores.push(loaded);
    assert.equal(loaded.get("developer"), "hello");
  } finally {
    cleanupTranscriptTest(dir, stores);
  }
});

test("different directories keep transcripts isolated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const dirA = path.join(dir, "a");
  const dirB = path.join(dir, "b");
  const stores: TerminalTranscriptStore[] = [];
  try {
    const storeA = new TerminalTranscriptStore(dirA);
    const storeB = new TerminalTranscriptStore(dirB);
    stores.push(storeA, storeB);
    storeA.append("developer", "workspace A");
    storeB.append("developer", "workspace B");

    const loadedA = new TerminalTranscriptStore(dirA);
    const loadedB = new TerminalTranscriptStore(dirB);
    stores.push(loadedA, loadedB);
    assert.equal(loadedA.get("developer"), "workspace A");
    assert.equal(loadedB.get("developer"), "workspace B");
  } finally {
    cleanupTranscriptTest(dir, stores);
  }
});

test("persisted store tail truncation preserves multi-byte UTF-8 characters", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const stores: TerminalTranscriptStore[] = [];
  try {
    // "你好世界" is 12 bytes in UTF-8 (3 bytes per char × 4 chars)
    const content = "abc你好世界";
    const agentDir = path.join(dir, "developer");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "2026-01-01-0001.log"), content);

    // tailBytes = 9 should split in the middle of "你好" (each 3 bytes)
    // but must not produce a replacement character
    const store = new TerminalTranscriptStore(dir, { tailBytes: 9 });
    stores.push(store);

    const result = store.get("developer");
    // Should NOT contain replacement character � (U+FFFD)
    assert.ok(!result.includes("�"), `tail should not contain replacement character, got: ${JSON.stringify(result)}`);
    // Should be a valid suffix of the original
    assert.ok(content.endsWith(result), `tail "${result}" should be a suffix of "${content}"`);
  } finally {
    cleanupTranscriptTest(dir, stores);
  }
});

test("dispose flushes pending buffers before closing handles", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const originalWriteSync = fs.writeSync;
  let writeAttempts = 0;
  const stores: TerminalTranscriptStore[] = [];
  try {
    // Make the first writeSync fail so data stays in pendingBuffers
    fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
      writeAttempts += 1;
      if (writeAttempts === 1) {
        const error = new Error("resource busy or locked") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return originalWriteSync(...args);
    }) as typeof fs.writeSync;

    const store = new TerminalTranscriptStore(dir);
    stores.push(store);
    store.append("developer", "should survive dispose");

    // Data is in pendingBuffers because first write failed
    // Now call dispose — it should flush before closing
    store.dispose();
    // Remove from stores so cleanup doesn't double-dispose
    stores.length = 0;

    // Reload and verify data was persisted
    fs.writeSync = originalWriteSync;
    const loaded = new TerminalTranscriptStore(dir);
    stores.push(loaded);
    assert.equal(loaded.get("developer"), "should survive dispose");
  } finally {
    fs.writeSync = originalWriteSync;
    cleanupTranscriptTest(dir, stores);
  }
});

test("persisted store ignores non-log files in directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-transcript-test-"));
  const stores: TerminalTranscriptStore[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "readme.txt"), "ignore me");
    const store = new TerminalTranscriptStore(dir);
    stores.push(store);
    assert.equal(store.get("readme"), "");
  } finally {
    cleanupTranscriptTest(dir, stores);
  }
});
