import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { resolveSlashSendTarget } from "../src/core/native-commands.ts";
import type { AgentCommand, AgentId } from "../src/shared/types.ts";

/**
 * 原生斜杠命令投递的服务端入口约束（issue #160 + 二轮 review）。
 *
 * 二轮 review 指出：客户端同时提交 content（频道历史）与 delivery.prompt
 * （runtime 执行文本）时，服务端只对后者做白名单校验，两者可以分叉，
 * 频道历史不再能审计实际执行的命令。修复后客户端只提交消息原文，
 * 是否按命令投递、投递给谁、发什么文本全部由服务端从 content 推导
 * （resolveSlashSendTarget：交互模式 + @员工: 前缀 + 权威命令快照），
 * 历史与执行天然同源。
 *
 * 按 tests/message-target.test.ts 的源码结构断言手法覆盖 handlePostMessage
 * 的接线；推导行为本身在 tests/app-slash-commands.test.ts 用真实函数覆盖。
 */

const serverSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/server/index.ts"),
  "utf-8",
);

describe("server wiring for native command delivery", () => {
  const handler = serverSource.match(/async function handlePostMessage\([\s\S]*?\n\}/)?.[0] ?? "";

  test("the server derives the delivery from the raw content, never from a client field", () => {
    assert.ok(handler, "handlePostMessage must exist in server/index.ts");
    assert.ok(
      !handler.includes("input.delivery"),
      "客户端提交的 delivery 字段必须被无视：历史与执行的唯一输入是消息原文",
    );
    assert.ok(
      !serverSource.includes("function parseNativeCommandDelivery"),
      "客户端投递载荷的解析器必须删除，服务端从 content 推导",
    );
    const deriveIndex = handler.indexOf("const delivery = resolveSlashSendTarget(");
    assert.ok(deriveIndex > 0, "服务端必须调用共享的 resolveSlashSendTarget 推导投递");
    const deriveCall = handler.slice(deriveIndex, handler.indexOf(");", deriveIndex));
    assert.ok(
      deriveCall.includes("content,"),
      "推导的第一个输入必须是消息原文 content（频道历史保存的同一字符串）",
    );
    assert.ok(
      deriveCall.includes('conversation.interactionMode ?? "direct"')
        && deriveCall.includes("conversation.lastDirectAgentId"),
      "目标判定必须复用会话的交互模式与最近直接对话员工，与 UI 菜单同一套语义",
    );
    assert.ok(
      deriveCall.includes("context.agents.states()")
        && deriveCall.includes("context.availableCommands()"),
      "前缀匹配与命令白名单必须读服务端权威状态，不得信任客户端快照",
    );
    assert.ok(
      serverSource.includes('resolveSlashSendTarget } from "../core/native-commands.ts"'),
      "推导逻辑必须来自 core 共享模块，UI 菜单与服务端发送门共用同一实现",
    );
  });

  test("delivery requests carrying attachments are rejected with a clear error", () => {
    assert.ok(handler, "handlePostMessage must exist in server/index.ts");
    const deliveryIndex = handler.indexOf("const delivery = resolveSlashSendTarget(");
    const rejectIndex = handler.indexOf("原生命令消息不支持附件");
    assert.ok(deliveryIndex > 0, "the derived delivery must be bound before the attachment check");
    assert.ok(rejectIndex > deliveryIndex, "attachment rejection must follow the derivation");
    const rejectBlock = handler.slice(deliveryIndex, rejectIndex);
    assert.ok(
      rejectBlock.includes("delivery && draftAttachments.length > 0"),
      "only requests that resolve to a native command and carry attachments must be rejected",
    );
    assert.ok(rejectBlock.includes("400"), "rejection must be a client error");
  });

  test("the enqueue sends the derived command text, not the raw channel text", () => {
    assert.ok(handler, "handlePostMessage must exist in server/index.ts");
    const enqueueIndex = handler.indexOf("enqueueNativeCommand(");
    assert.ok(enqueueIndex > 0, "native commands must be enqueued through the run manager");
    const enqueueCall = handler.slice(enqueueIndex, handler.indexOf(");", enqueueIndex));
    assert.ok(
      enqueueCall.includes("delivery.agentId, delivery.commandText"),
      "runtime 必须收到从 content 推导出的命令文本",
    );
    assert.ok(
      !enqueueCall.includes(", content,"),
      "带 @员工: 前缀的频道原文不得直接发往 runtime",
    );
  });
});

test("the derived command text strips the prefix so history and execution share one source", () => {
  const agents = [
    { id: "developer" as AgentId, label: "开发" },
    { id: "reviewer" as AgentId, label: "评审" },
  ];
  const commands: Record<AgentId, readonly AgentCommand[]> = {
    [agents[0]!.id]: [{ name: "review", description: "审查当前变更" }],
    [agents[1]!.id]: [],
  };
  const content = "@开发: /review 聚焦登录流程";

  // 与服务端相同的推导调用：投递文本剥离前缀，频道历史仍保存 content 原文。
  const delivery = resolveSlashSendTarget(content, "supervised", undefined, agents, commands);

  assert.deepEqual(delivery, { agentId: "developer", commandText: "/review 聚焦登录流程" });
  assert.notEqual(delivery!.commandText, content, "runtime 不得收到带前缀的原文");
  assert.ok(content.startsWith("@开发:"), "频道历史保存的仍是用户输入的原文");
});
