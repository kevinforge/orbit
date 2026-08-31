import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { AgentModelStateStore, storageKeyAgentId, supervisorStorageKey } from "../src/core/agent-model-state-store.ts";
import { createSupervisorProfile, INTERNAL_SUPERVISOR_ID } from "../src/core/agent-profiles.ts";
import type { AgentModelStateSnapshot, AgentRuntimeKind } from "../src/shared/types.ts";

/**
 * Issue #153：监工的运行时与模型偏好可按会话配置。
 *
 * 覆盖点：
 * - 模型偏好的 runtime 归属门控（跨运行时不应用）。
 * - 监工模型快照按会话隔离，不同会话互不覆盖。
 * - UI 的监工设置入口与保存路径（无 React 渲染环境，沿用源码扫描风格）。
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-supervisor-"));
}

function snapshot(runtimeKind: AgentRuntimeKind): AgentModelStateSnapshot {
  return {
    agentId: INTERNAL_SUPERVISOR_ID,
    runtimeKind,
    configId: "model",
    choices: [{ value: "m1", name: "M1" }],
    currentValue: undefined,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("supervisor model preference gating", () => {
  test("a runtime-matching preference is applied to the supervisor profile", () => {
    const profile = createSupervisorProfile("/tmp/project", {
      runtime: "codex",
      model: { preferredModelId: "gpt-5-codex", runtimeKind: "codex" },
    });

    assert.equal(profile.runtime, "codex");
    assert.equal(profile.preferredModelId, "gpt-5-codex");
  });

  test("a cross-runtime preference is ignored", () => {
    // value ID 不跨 runtime 通用：偏好属于 codex，当前运行时是 codebuddy。
    const profile = createSupervisorProfile("/tmp/project", {
      runtime: "codebuddy",
      model: { preferredModelId: "gpt-5-codex", runtimeKind: "codex" },
    });

    assert.equal(profile.preferredModelId, undefined);
  });

  test("a blank preference is not applied", () => {
    const profile = createSupervisorProfile("/tmp/project", {
      runtime: "codex",
      model: { preferredModelId: "   ", runtimeKind: "codex" },
    });

    assert.equal(profile.preferredModelId, undefined);
  });

  test("the supervisor keeps its internal identity and Chinese display name", () => {
    const profile = createSupervisorProfile("/tmp/project", { runtime: "codebuddy" });

    assert.equal(profile.id, INTERNAL_SUPERVISOR_ID);
    assert.equal(profile.name, "监工");
    assert.equal(profile.internal, true);
  });
});

describe("supervisor model snapshots are isolated per conversation", () => {
  test("two conversations keep their own supervisor snapshot", () => {
    const store = new AgentModelStateStore(tmpDir());

    store.update("ws1", snapshot("codex"), supervisorStorageKey("conv-a"));
    store.update("ws1", snapshot("codebuddy"), supervisorStorageKey("conv-b"));

    assert.equal(store.get("ws1", supervisorStorageKey("conv-a"))?.runtimeKind, "codex");
    assert.equal(store.get("ws1", supervisorStorageKey("conv-b"))?.runtimeKind, "codebuddy");
  });

  test("overwriting one conversation does not disturb another or regular employees", () => {
    const store = new AgentModelStateStore(tmpDir());
    const employeeSnapshot: AgentModelStateSnapshot = {
      ...snapshot("codex"),
      agentId: "implementation",
    };

    store.update("ws1", snapshot("codex"), supervisorStorageKey("conv-a"));
    store.update("ws1", employeeSnapshot);
    store.update("ws1", snapshot("codebuddy"), supervisorStorageKey("conv-b"));

    assert.equal(store.get("ws1", supervisorStorageKey("conv-a"))?.runtimeKind, "codex");
    assert.equal(store.get("ws1", supervisorStorageKey("conv-b"))?.runtimeKind, "codebuddy");
    assert.equal(store.get("ws1", "implementation")?.agentId, "implementation");
  });

  test("the composite storage key still exposes the supervisor agent id", () => {
    assert.equal(storageKeyAgentId(supervisorStorageKey("conv-a")), INTERNAL_SUPERVISOR_ID);
    assert.equal(storageKeyAgentId("implementation"), "implementation");
  });

  test("supervisor snapshots survive a reload", () => {
    const dir = tmpDir();
    new AgentModelStateStore(dir).update("ws1", snapshot("codebuddy"), supervisorStorageKey("conv-a"));

    const reloaded = new AgentModelStateStore(dir).get("ws1", supervisorStorageKey("conv-a"));

    assert.equal(reloaded?.runtimeKind, "codebuddy");
    assert.equal(reloaded?.agentId, INTERNAL_SUPERVISOR_ID);
  });
});

const appSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/ui/App.tsx"),
  "utf-8",
);

describe("supervisor settings entry in the UI", () => {
  test("the collaboration menu exposes a dedicated supervisor settings entry", () => {
    // 入口与模式项并列，避免嵌套按钮；复杂协作开启前后都可点。
    assert.match(appSource, /supervisorSettingsTrigger/, "应有独立的监工设置入口样式类");
    assert.match(appSource, /监工设置/, "入口文案应使用产品术语“监工设置”");
    assert.match(appSource, /function SupervisorSettingsPanel/, "应存在监工设置面板组件");
    assert.match(appSource, /showSupervisorSettings/, "入口应能打开监工设置面板");
  });

  test("saving uses the explicit page context endpoint", () => {
    assert.match(
      appSource,
      /withPageContext\(`\/api\/conversations\/\$\{conversationId\}\/supervisor-config`, targetContext\)/,
      "保存监工配置必须走显式页面上下文接口，不能依赖全局 active 指针。",
    );
  });

  test("saving without a conversation creates one and adopts its id first", () => {
    const body = appSource.slice(appSource.indexOf("async function saveSupervisorConfig"));
    const createIdx = body.indexOf('/api/conversations"');
    const saveIdx = body.indexOf("/supervisor-config");

    assert.notStrictEqual(createIdx, -1, "无会话时应先创建会话");
    assert.notStrictEqual(saveIdx, -1, "随后再保存监工配置");
    assert.ok(createIdx < saveIdx, "必须先创建并采用会话 ID，再保存配置");
  });

  test("probing the supervisor model list carries the conversation id", () => {
    assert.match(
      appSource,
      /params\.set\("conversationId", conversationId\)/,
      "监工是所有会话共用的内部 ID，探测模型必须带会话维度。",
    );
  });

  test("the panel addresses the supervisor with the product term only", () => {
    const start = appSource.indexOf("function SupervisorSettingsPanel");
    const panel = appSource.slice(start, appSource.indexOf("function preferredSupervisionRuntime"));
    assert.ok(start >= 0 && panel.length > 0, "Could not locate SupervisorSettingsPanel in App.tsx");

    assert.match(panel, /<h2>监工设置<\/h2>/, "面板标题应使用产品术语“监工”");
    assert.match(panel, /跟随运行时默认/, "应提供“跟随运行时默认”选项");
    assert.match(panel, /刷新模型列表/, "应提供刷新模型列表入口");
    // 可见文案用“监工”，内部名只作为标识符（radio name 等属性）出现。
    assert.ok(
      (panel.match(/监工/g) ?? []).length >= 3,
      "面板可见文案应统一使用“监工”，而不是内部名",
    );
  });
});
