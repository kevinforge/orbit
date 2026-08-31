import { EventEmitter } from "node:events";
import http from "node:http";
import assert from "node:assert/strict";
import test from "node:test";

import { MAX_BODY_SIZE, readJson, RequestBodyTooLargeError } from "../src/server/read-json.ts";

/**
 * PR #147 审查修复：超限请求体此前直接 `req.destroy()`，客户端只看到
 * `fetch failed`，拿不到任何可诊断信息。改为抛出可识别的错误，由请求入口
 * 翻译成 413。
 */

/** 只需 readJson 用到的 IncomingMessage 行为：事件序列 + setEncoding。 */
function fakeRequest(): http.IncomingMessage {
  const emitter = new EventEmitter() as http.IncomingMessage;
  emitter.setEncoding = () => emitter;
  return emitter;
}

function feed(req: http.IncomingMessage, chunks: string[]): void {
  queueMicrotask(() => {
    for (const chunk of chunks) req.emit("data", chunk);
    req.emit("end");
  });
}

const MB = 1024 * 1024;

test("readJson parses a complete JSON body", async () => {
  const req = fakeRequest();
  const pending = readJson(req);
  feed(req, ['{"ok":', "true}"]);
  assert.deepEqual(await pending, { ok: true });
});

test("readJson resolves an empty body to an empty object", async () => {
  const req = fakeRequest();
  const pending = readJson(req);
  feed(req, []);
  assert.deepEqual(await pending, {});
});

test("readJson rejects an over-limit body with a diagnosable, actionable error", async () => {
  const req = fakeRequest();
  const pending = readJson(req);
  feed(req, ["x".repeat(6 * MB), "y".repeat(6 * MB)]);

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof RequestBodyTooLargeError, "the failure must be identifiable as a size overflow");
    assert.equal(error.limitBytes, MAX_BODY_SIZE);
    assert.match(
      error.message,
      /请求体过大（上限 10MB）/,
      "the client must be told the limit instead of seeing a dropped connection",
    );
    assert.match(error.message, /5MB/, "the message must point at the actionable per-file limit");
    return true;
  });
});

test("a body that reaches the limit exactly is still accepted", async () => {
  const req = fakeRequest();
  const pending = readJson(req);
  const body = JSON.stringify({ data: "a".repeat(MAX_BODY_SIZE - 32) });
  feed(req, [body]);

  assert.equal((await pending as { data: string }).data.length, MAX_BODY_SIZE - 32);
});

test("the default limit leaves headroom for a maximal base64 attachment", () => {
  // 5MB 附件 → 约 6.7MB base64，10MB 上限留有余量。
  assert.equal(MAX_BODY_SIZE, 10 * MB);
  assert.ok(MAX_BODY_SIZE > Math.ceil(5 * MB * 4 / 3));
});
