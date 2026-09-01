import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  filterSlashCommands,
  findSlashCommandDraft,
  resolveSlashCommandTarget,
  resolveSlashSendTarget,
  splitSlashCommandName,
} from "../src/ui/App.tsx";
import type { AgentCommand, AgentCommandsSnapshot, AgentId } from "../src/shared/types.ts";

const developer: AgentId = "developer";
const reviewer: AgentId = "reviewer";

const agents = [
  { id: developer, label: "开发" },
  { id: reviewer, label: "评审" },
];

function snapshot(commands: readonly AgentCommand[]): AgentCommandsSnapshot {
  return { status: "ready", commands };
}

const commands: Record<AgentId, AgentCommandsSnapshot> = {
  [developer]: snapshot([
    { name: "init", description: "初始化项目" },
    { name: "review", description: "审查当前变更", inputHint: "可选关注点" },
  ]),
  [reviewer]: snapshot([{ name: "plan", description: "生成计划" }]),
};

test("slash send targets the last direct employee without a prefix in direct mode", () => {
  assert.deepEqual(
    resolveSlashSendTarget("/init", "direct", developer, agents, commands),
    { agentId: developer, commandText: "/init" },
  );
  assert.deepEqual(
    resolveSlashSendTarget("/review 聚焦登录流程", "direct", developer, agents, commands),
    { agentId: developer, commandText: "/review 聚焦登录流程" },
    "命令参数不影响投递判定",
  );
  // 简单/复杂协作没有默认接收方，无前缀时不提供原生命令入口。
  assert.equal(resolveSlashSendTarget("/init", "collaborative", developer, agents, commands), null);
  assert.equal(resolveSlashSendTarget("/init", "supervised", developer, agents, commands), null);
});

test("an explicit @员工: prefix routes the command to that employee in every mode", () => {
  assert.deepEqual(
    resolveSlashSendTarget("@开发: /init", "supervised", reviewer, agents, commands),
    { agentId: developer, commandText: "/init" },
    "复杂协作下显式前缀直达该员工，与指派路由走向一致",
  );
  assert.deepEqual(
    resolveSlashSendTarget("@开发: /init", "collaborative", undefined, agents, commands),
    { agentId: developer, commandText: "/init" },
  );
  assert.deepEqual(
    resolveSlashSendTarget("@评审: /plan", "direct", developer, agents, commands),
    { agentId: reviewer, commandText: "/plan" },
    "前缀命中即切换目标，不沿用最近直接对话员工",
  );
});

test("the prefix shares the routing marker semantics: fullwidth colon and case-insensitive labels", () => {
  assert.deepEqual(
    resolveSlashSendTarget("@开发： /init", "supervised", reviewer, agents, commands),
    { agentId: developer, commandText: "/init" },
    "全角冒号与半角冒号等价，与指派路由共用同一套标记语义",
  );
  // 前缀标签匹配忽略大小写（与指派路由 byName 一致）。
  const casedAgents = [
    { id: developer, label: "Ops" },
    { id: reviewer, label: "评审" },
  ];
  const casedCommands: Record<AgentId, AgentCommandsSnapshot> = {
    [developer]: snapshot([{ name: "run", description: "运行检查" }]),
    [reviewer]: snapshot([{ name: "plan", description: "生成计划" }]),
  };
  assert.deepEqual(
    resolveSlashSendTarget("@ops: /run", "direct", developer, casedAgents, casedCommands),
    { agentId: developer, commandText: "/run" },
  );
  assert.deepEqual(resolveSlashCommandTarget("@OPS： /run", "direct", developer, casedAgents), {
    agentId: developer,
    commandText: "/run",
  });
});

test("slash send falls back to normal routing without a target or an announced command", () => {
  // 尚未确定目标员工。
  assert.equal(resolveSlashSendTarget("/init", "direct", undefined, agents, commands), null);
  assert.equal(resolveSlashSendTarget("/init", "collaborative", undefined, agents, commands), null);
  // 目标员工未通告该命令，或未通告任何命令。
  assert.equal(resolveSlashSendTarget("/compact", "direct", developer, agents, commands), null);
  assert.equal(resolveSlashSendTarget("@评审: /init", "direct", developer, agents, commands), null);
  // 前缀标签必须唯一命中已启用员工：未知或歧义标签都不投递。
  assert.equal(resolveSlashSendTarget("@不存在: /init", "supervised", undefined, agents, commands), null);
  const duplicated = [...agents, { id: "developer-2" as AgentId, label: "开发" }];
  assert.equal(resolveSlashSendTarget("@开发: /init", "direct", developer, duplicated, commands), null);
  // 命令名按完整词匹配：前缀命中不得投递。
  assert.equal(resolveSlashSendTarget("/ini", "direct", developer, agents, commands), null);
  assert.equal(resolveSlashSendTarget("@开发: /ini", "direct", developer, agents, commands), null);
  // 非斜杠消息走路由。
  assert.equal(resolveSlashSendTarget("hello /init", "direct", developer, agents, commands), null);
});

test("slash command target resolution mirrors the send target without the command gate", () => {
  assert.deepEqual(resolveSlashCommandTarget("@开发: 你好", "supervised", undefined, agents), {
    agentId: developer,
    commandText: "你好",
  });
  // 前缀之后的空白分隔（含制表符）都算前缀结束。
  assert.deepEqual(resolveSlashCommandTarget("@开发:\t/init", "direct", reviewer, agents), {
    agentId: developer,
    commandText: "/init",
  });
  // 无前缀时直接协作沿用最近员工，其余模式没有目标。
  assert.deepEqual(resolveSlashCommandTarget("你好", "direct", reviewer, agents), {
    agentId: reviewer,
    commandText: "你好",
  });
  assert.equal(resolveSlashCommandTarget("你好", "collaborative", reviewer, agents), null);
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

test("slash command draft brackets the /command after an @员工: prefix", () => {
  const value = "@开发: /ini";
  assert.deepEqual(
    findSlashCommandDraft(value, value.length),
    { start: 5, end: value.length, query: "ini" },
    "草稿从前缀之后开始，补全时保留 @员工: 前缀",
  );
  assert.deepEqual(findSlashCommandDraft("@开发: /", 6), { start: 5, end: 6, query: "" });
  // 全角冒号前缀与半角等价：草稿同样从前缀之后开始。
  const fullwidth = "@开发： /";
  assert.deepEqual(
    findSlashCommandDraft(fullwidth, fullwidth.length),
    { start: 5, end: fullwidth.length, query: "" },
  );
  // 光标还在前缀内、尚未输入 "/" 时不弹命令菜单。
  assert.equal(findSlashCommandDraft("@开", 2), null);
  assert.equal(findSlashCommandDraft("@开发: ", 5), null);
  // 参数阶段不弹菜单。
  assert.equal(findSlashCommandDraft("@开发: /init foo", 15), null);
});

test("filterSlashCommands returns the full list for the bare slash query", () => {
  // 命令上百时不再截断候选：完整列表交给面板独立滚动、键盘翻页。
  const many: AgentCommand[] = Array.from({ length: 105 }, (_, index) => ({
    name: `cmd${String(index).padStart(2, "0")}`,
    description: `命令 ${index}`,
  }));
  const bare = filterSlashCommands(many, "");
  assert.equal(bare.total, 105);
  assert.equal(bare.shown.length, 105);
  assert.deepEqual(bare.shown[0], many[0]);

  assert.deepEqual(filterSlashCommands(many, "cmd29").shown, [many[29]]);
  assert.deepEqual(filterSlashCommands(many, "missing"), { shown: [], total: 0 });
});

test("filterSlashCommands searches names and descriptions with prefix matches first", () => {
  const mixed: AgentCommand[] = [
    { name: "review", description: "审查当前变更" },
    { name: "review-branch", description: "审查分支差异" },
    { name: "mcp:review", description: "运行远端检查器" },
    { name: "audit", description: "Review uncommitted changes" },
    { name: "plan", description: "生成计划" },
  ];

  // 命中排序：名称前缀 → 名称包含 → 仅描述包含；大小写不敏感。
  const hit = filterSlashCommands(mixed, "REV");
  assert.deepEqual(hit.shown.map((command) => command.name), ["review", "review-branch", "mcp:review", "audit"]);
  assert.equal(hit.total, 4);

  // 中文关键词走描述搜索。
  assert.deepEqual(
    filterSlashCommands(mixed, "审查").shown.map((command) => command.name),
    ["review", "review-branch"],
    "描述包含关键词的命令都命中，保持通告顺序",
  );
});

test("splitSlashCommandName separates the namespace tag from the base name", () => {
  assert.deepEqual(splitSlashCommandName("init"), { namespace: null, base: "init" });
  assert.deepEqual(splitSlashCommandName("mcp:fetch"), { namespace: "mcp", base: "fetch" });
  assert.deepEqual(splitSlashCommandName("$product-design:share"), { namespace: "$product-design", base: "share" });
  // 命名空间内多级冒号保留完整前缀；冒号在开头或结尾时不拆分。
  assert.deepEqual(splitSlashCommandName("a:b:c"), { namespace: "a:b", base: "c" });
  assert.deepEqual(splitSlashCommandName(":lead"), { namespace: null, base: ":lead" });
  assert.deepEqual(splitSlashCommandName("trail:"), { namespace: null, base: "trail:" });
});

describe("composer key wiring for the slash command menu", () => {
  const appSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/ui/App.tsx"),
    "utf-8",
  );

  test("the slash menu branch handles Enter/Tab, arrows, and Esc inside handleComposerKeyDown", () => {
    const handler = appSource.match(/function handleComposerKeyDown\([\s\S]*?\n  \}/)?.[0] ?? "";
    assert.ok(handler, "handleComposerKeyDown must exist in App.tsx");
    const slashBranch = handler.match(/if \(slashCommandCandidates\.length > 0\) \{[\s\S]*?\n    \}/)?.[0] ?? "";
    assert.ok(slashBranch, "the slash menu must get first crack at composer keys");
    assert.ok(slashBranch.includes("chooseSlashCommand("), "Enter/Tab must complete the command instead of sending");
    assert.ok(slashBranch.includes("setSlashDismissed(true)"), "Esc must dismiss via the dedicated flag so the menu can reopen");
    assert.ok(slashBranch.includes('"PageDown"') && slashBranch.includes('"PageUp"'), "PgUp/PgDn must page through long command lists");
    assert.ok(
      !slashBranch.includes("setInputFocused(false)"),
      "Esc must not clear inputFocused: the textarea keeps DOM focus, so onFocus never refires and the menu could never reopen",
    );
  });

  test("slash dismissal blocks candidates, gates on a target, and resets when the draft is gone", () => {
    const memo = appSource.match(/const slashCommandCandidates = useMemo\(\(\) => \{[\s\S]*?\n  \}, \[/);
    assert.ok(memo, "slashCommandCandidates memo must exist in App.tsx");
    assert.ok(memo[0].includes("slashDismissed"), "candidates must respect the dismissal flag");
    assert.ok(memo[0].includes("slashCommandTarget"), "candidates must be gated on a resolved target employee");

    const resetEffect = appSource.match(
      /useEffect\(\(\) => \{\s*if \(!slashCommandDraft\) \{\s*setSlashDismissed\(false\);\s*\}\s*\}, \[slashCommandDraft\]\);/,
    );
    assert.ok(resetEffect, "dismissal must reset when the slash draft disappears so Esc can re-invoke the menu");
  });

  test("an active mention draft suppresses the slash draft so the two menus stay exclusive", () => {
    const memoIndex = appSource.indexOf("const slashCommandDraft = useMemo(");
    assert.ok(memoIndex > 0, "slashCommandDraft memo must exist in App.tsx");
    const memoBody = appSource.slice(memoIndex, appSource.indexOf(");", memoIndex));
    assert.ok(
      memoBody.includes("mentionDraft ? null : findSlashCommandDraft"),
      "a mention draft must take priority over the slash command draft",
    );
  });

  test("slash completion splices only the /command draft, preserving the prefix and trailing text", () => {
    const fnIndex = appSource.indexOf("function chooseSlashCommand(");
    assert.ok(fnIndex > 0, "chooseSlashCommand must exist in App.tsx");
    const fnBody = appSource.slice(fnIndex, appSource.indexOf("\n  }", fnIndex));
    assert.ok(
      fnBody.includes("content.slice(0, slashCommandDraft.start)"),
      "completion must keep the @员工: prefix before the draft start",
    );
    assert.ok(
      fnBody.includes("content.slice(slashCommandDraft.end)"),
      "completion must keep any trailing text after the cursor",
    );
  });

  test("the status phase stays keyboard-reachable: the outer guard admits a candidate-less menu", () => {
    assert.ok(
      appSource.includes("mentionCandidates.length > 0 || slashMenuOpen"),
      "状态行（获取中/无命令/失败）没有候选，外层守卫必须按菜单开放而不是候选数分流，否则 Esc 关不掉、Enter 把未完成的 / 草稿当普通消息发出",
    );
    const handler = appSource.match(/function handleComposerKeyDown\([\s\S]*?\n  \}/)?.[0] ?? "";
    assert.ok(handler, "handleComposerKeyDown must exist in App.tsx");
    const candidatesBranch = handler.match(/if \(slashCommandCandidates\.length > 0\) \{[\s\S]*?\n    \}/)?.[0] ?? "";
    assert.ok(candidatesBranch, "the candidates branch must exist first");
    const statusBranch = handler.slice((handler.indexOf(candidatesBranch)) + candidatesBranch.length);
    assert.match(
      statusBranch,
      /if \(slashMenuOpen && \(event\.key === "Enter" \|\| event\.key === "Tab"\)\) \{\s*event\.preventDefault\(\);\s*return;/,
      "状态行阶段 Enter/Tab 必须被吞掉，不得把未完成的 / 草稿当普通消息发出",
    );
    assert.match(
      statusBranch,
      /if \(slashMenuOpen && event\.key === "Escape"\) \{\s*event\.preventDefault\(\);\s*setSlashDismissed\(true\);/,
      "状态行阶段 Esc 必须能关闭菜单",
    );
  });
});

describe("probe lifecycle for the slash command menu", () => {
  const appSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/ui/App.tsx"),
    "utf-8",
  );

  test("probe responses land with the requesting page context and pending state is per page+employee", () => {
    const probe = appSource.match(/async function requestAgentCommands\([\s\S]*?\n  \}/)?.[0] ?? "";
    assert.ok(probe, "requestAgentCommands must exist in App.tsx");
    assert.ok(
      probe.includes("const requestedContext = currentPageContext();"),
      "探测请求必须绑定发起时的页面上下文",
    );
    assert.ok(
      probe.includes("commandProbeKey(requestedContext.workspaceId, requestedContext.conversationId, agentId)"),
      "在途标记必须按 页面+员工 记，跨页探测互不干扰",
    );
    const applySnapshot = probe.match(/const applySnapshot = \(snapshot: AgentCommandsSnapshot\) => \{[\s\S]*?\n    \};/)?.[0] ?? "";
    assert.ok(applySnapshot, "快照落地函数必须存在");
    assert.ok(
      applySnapshot.includes("workspaceId: requestedContext.workspaceId")
        && applySnapshot.includes("conversationId: requestedContext.conversationId"),
      "探测响应必须按发起请求时的页面落地：applyEvent 的页面门控会丢弃不属于当前页的落地，不污染切换后的新页快照",
    );
  });

  test("snapshot absence triggers one probe per page and the loading phase reads the matching pending flag", () => {
    const phase = appSource.match(/const slashMenuPhase[\s\S]*?: "empty";/)?.[0] ?? "";
    assert.ok(phase, "slashMenuPhase must exist in App.tsx");
    assert.ok(
      phase.includes("commandProbeKey(state.workspace.id, state.conversation.id"),
      "状态行必须读当前页面的在途标记，跨页探测不得误判本页进行中",
    );
    const effect = appSource.match(
      /useEffect\(\(\) => \{\s*if \(!slashMenuOpen \|\| !slashCommandTarget\) return;[\s\S]*?\}, \[slashMenuOpen/,
    );
    assert.ok(effect, "菜单打开而快照未知时必须自动探测一次");
    assert.ok(
      effect?.[0].includes("state.agentCommands[slashCommandTarget.agentId]"),
      "已有快照（含空列表与失败态）时不得重复探测：失败由用户显式重试，避免反复拉起 runtime 进程",
    );
  });
});
