import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 原生斜杠命令投递的服务端入口约束（issue #160）。
 *
 * 按 tests/message-target.test.ts 的源码结构断言手法覆盖 handlePostMessage：
 * - delivery 载荷必须是 { type, agentId, prompt }，prompt 是发给 runtime 的
 *   命令文本（`@员工:` 前缀之后的部分），复用 shared 类型而非本地副本；
 * - 携带 delivery 的请求不得带附件：命令通道没有附件承载路径，静默丢弃
 *   附件会让用户以为附件已随命令送达，必须明确拒绝；
 * - 命令名白名单校验与入队都必须基于 delivery.prompt，用户原文 content
 *   只进频道历史，不得作为命令文本发往 runtime。
 */

const serverSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/server/index.ts"),
  "utf-8",
);

describe("server wiring for native command delivery", () => {
  const handler = serverSource.match(/async function handlePostMessage\([\s\S]*?\n\}/)?.[0] ?? "";
  const parser = serverSource.match(/function parseNativeCommandDelivery\([\s\S]*?\n\}/)?.[0] ?? "";

  test("delivery payloads reuse the shared type and carry a slash-prefixed prompt", () => {
    assert.ok(parser, "parseNativeCommandDelivery must exist in server/index.ts");
    assert.ok(parser.includes('input.type !== "acp_command"'), "the delivery type must be validated");
    assert.ok(parser.includes("input.agentId"), "the target employee must be validated");
    assert.ok(
      parser.includes('input.prompt.trim().startsWith("/")'),
      "the prompt must be validated as slash command text",
    );
    assert.ok(
      serverSource.includes("NativeCommandDelivery, PermissionDecision"),
      "the shared NativeCommandDelivery type must be imported",
    );
    assert.ok(
      !serverSource.includes("type NativeCommandDelivery = {"),
      "a private duplicate of the shared type must not reappear",
    );
  });

  test("delivery requests carrying attachments are rejected with a clear error", () => {
    assert.ok(handler, "handlePostMessage must exist in server/index.ts");
    const deliveryIndex = handler.indexOf("const delivery = parsedDelivery.delivery;");
    const rejectIndex = handler.indexOf("原生命令消息不支持附件");
    assert.ok(deliveryIndex > 0, "the parsed delivery must be bound before the attachment check");
    assert.ok(rejectIndex > deliveryIndex, "attachment rejection must follow the delivery parse");
    const rejectBlock = handler.slice(deliveryIndex, rejectIndex);
    assert.ok(
      rejectBlock.includes("delivery && draftAttachments.length > 0"),
      "only requests that carry both a delivery and attachments must be rejected",
    );
    assert.ok(rejectBlock.includes("400"), "rejection must be a client error");
  });

  test("command validation and enqueue read delivery.prompt, not the raw channel text", () => {
    assert.ok(handler, "handlePostMessage must exist in server/index.ts");
    assert.ok(
      handler.includes("nativeCommandName(delivery.prompt)"),
      "the command-name whitelist must be checked against delivery.prompt",
    );
    const enqueueIndex = handler.indexOf("enqueueNativeCommand(");
    assert.ok(enqueueIndex > 0, "native commands must be enqueued through the run manager");
    const enqueueCall = handler.slice(enqueueIndex, handler.indexOf(");", enqueueIndex));
    assert.ok(
      enqueueCall.includes("delivery.prompt"),
      "the runtime prompt must be the command text after any @员工: prefix",
    );
    assert.ok(
      !enqueueCall.includes(", content,"),
      "the raw channel text must never be sent to the runtime as the command",
    );
  });
});
