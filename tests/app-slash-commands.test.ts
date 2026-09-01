import test from "node:test";
import assert from "node:assert/strict";

import { findSlashCommandDraft, resolveSlashSendTarget } from "../src/ui/App.tsx";
import type { AgentCommand, AgentId } from "../src/shared/types.ts";

const developer: AgentId = "developer";
const reviewer: AgentId = "reviewer";

const commands: Record<AgentId, readonly AgentCommand[]> = {
  [developer]: [
    { name: "init", description: "初始化项目" },
    { name: "review", description: "审查当前变更", inputHint: "可选关注点" },
  ],
  [reviewer]: [],
};

test("slash send resolves only announced commands for the current target employee", () => {
  // 直接协作：目标是最近一次对话的员工。
  assert.equal(
    resolveSlashSendTarget("/init", "direct", developer, null, commands),
    developer,
  );
  assert.equal(
    resolveSlashSendTarget("/review 聚焦登录流程", "direct", developer, null, commands),
    developer,
    "命令参数不影响投递判定",
  );
  // 共同协作：目标是输入框选中的员工。
  assert.equal(
    resolveSlashSendTarget("/init", "collaborative", undefined, developer, commands),
    developer,
  );
  // 复杂协作：接收方是监工，不提供原生命令入口。
  assert.equal(
    resolveSlashSendTarget("/init", "supervised", developer, developer, commands),
    null,
  );
});

test("slash send falls back to normal routing without a target or an advertised command", () => {
  // 尚未确定目标员工。
  assert.equal(resolveSlashSendTarget("/init", "direct", undefined, null, commands), null);
  assert.equal(resolveSlashSendTarget("/init", "collaborative", undefined, null, commands), null);
  // 目标员工未通告该命令，或未通告任何命令。
  assert.equal(resolveSlashSendTarget("/compact", "direct", developer, null, commands), null);
  assert.equal(resolveSlashSendTarget("/init", "direct", reviewer, null, commands), null);
  // 命令名按完整词匹配：前缀命中不得投递。
  assert.equal(resolveSlashSendTarget("/ini", "direct", developer, null, commands), null);
  // 非斜杠消息走路由。
  assert.equal(resolveSlashSendTarget("hello /init", "direct", developer, null, commands), null);
});

test("slash command draft only matches a bare /command under the cursor", () => {
  assert.deepEqual(findSlashCommandDraft("/ini", 4), { start: 0, end: 4, query: "ini" });
  assert.deepEqual(findSlashCommandDraft("/", 1), { start: 0, end: 1, query: "" });
  // 光标在中间时按光标前文本判断。
  assert.deepEqual(findSlashCommandDraft("/init foo", 5), { start: 0, end: 5, query: "init" });
  // 命令参数阶段与普通文本不弹菜单。
  assert.equal(findSlashCommandDraft("/init foo", 9), null);
  assert.equal(findSlashCommandDraft("hello /init", 11), null);
  assert.equal(findSlashCommandDraft("/init ", 6), null);
});
