import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { configsToProfiles, INTERNAL_SUPERVISOR_ID } from "../core/agent-profiles.ts";
import { disposeAcpConnectionPool, probeAcpModelState } from "../core/acp-runtime.ts";
import { defaultAcpRunnerRegistry } from "../core/acp-runner-registry.ts";
import { AGENT_TEAM_TEMPLATES, AgentConfigStore, validateAgentConfigs } from "../core/agent-config-store.ts";
import { AgentModelStateStore, supervisorStorageKey } from "../core/agent-model-state-store.ts";
import { probeAllRuntimes, runtimeKindToCliKey, type RuntimeProbeResult } from "../core/runtime-probe.ts";
import type { AgentConfig } from "../core/agent-config-store.ts";
import { WorkspaceConfigStore } from "../core/workspace-config-store.ts";
import type { WorkspaceConfig } from "../core/workspace-config-store.ts";
import { GlobalConfigStore } from "../core/global-config-store.ts";
import type { GlobalConfig } from "../core/global-config-store.ts";
import { ConversationStore } from "../core/conversation-store.ts";
import { EventBus } from "../core/event-bus.ts";
import { MessageStore } from "../core/message-store.ts";
import { SessionStore } from "../core/session-store.ts";
import { WorkspaceStore } from "../core/workspace-store.ts";
import { initialAgentConfigsForWorkspacePreset } from "../core/workspace-agent-presets.ts";
import { getWorkspacePresets } from "../core/workspace-presets.ts";
import { migrateChannelLayer } from "../core/migrate-channel-layer.ts";
import { cleanupHistory } from "../core/history-retention.ts";
import type { AgentConfigWithModelState, AgentModelProbeResponse, AgentModelProbeState, ApprovalMode, Conversation, ConversationInfo, ElicitationResponse, InteractionMode, MessagePage, NativeCommandDelivery, PermissionDecision, RunningSummary, SupervisorConfig, WorkspaceInfo, AgentId } from "../shared/types.ts";
import { isAgentRuntimeKind, isInteractionMode } from "../shared/types.ts";
import { ATTACHMENT_LIMITS } from "../shared/types.ts";
import { AttachmentStore } from "../core/attachment-store.ts";
import { buildAttachmentHeaders } from "./attachment-response.ts";
import { canSendMessage } from "../shared/message-validation.ts";
import { ConversationContext } from "./conversation-context.ts";
import { findPortOwners, isOrbitPortOwner, stopPortOwner } from "./port-recovery.ts";
import { readJson, RequestBodyTooLargeError } from "./read-json.ts";
import {
  resolveTargetIds as resolveTargetDetails,
  type RequestTarget,
  type TargetMissingReason,
} from "./request-target.ts";
import { serveStatic } from "./static-server.ts";
import { SseHub } from "./sse-hub.ts";
import { buildWorkspaceWorkAnalysis } from "./workspace-work-analysis.ts";
import { resolveRevealTarget, revealInFileManager } from "./local-path-reveal.ts";

const DEFAULT_PORT = 4317;
const requestedPort = Number(process.env.ORBIT_PORT ?? DEFAULT_PORT);
let activePort = requestedPort;
const UNTITLED_CONVERSATION_NAME = "新会话";
const EMPTY_WORKSPACE: WorkspaceInfo = { id: "", name: "", path: "" };
const EMPTY_CONVERSATION: ConversationInfo = { id: "", name: "", interactionMode: "direct" };

function toActiveConversation(conversation: Conversation | {
  id: string;
  name: string;
  interactionMode?: InteractionMode;
  lastDirectAgentId?: ConversationInfo["lastDirectAgentId"];
  supervisorConfig?: ConversationInfo["supervisorConfig"];
}): ConversationInfo {
  return {
    id: conversation.id,
    name: conversation.name,
    interactionMode: conversation.interactionMode ?? "direct",
    lastDirectAgentId: conversation.lastDirectAgentId,
    supervisorConfig: conversation.supervisorConfig,
  };
}
const execFileAsync = promisify(execFile);

// --- Shared singletons ---
const eventBus = new EventBus();
const sseHub = new SseHub();
const workspaceStore = new WorkspaceStore();
const configStore = new AgentConfigStore();
const agentModelStateStore = new AgentModelStateStore();
const workspaceConfigStore = new WorkspaceConfigStore();
const globalConfigStore = new GlobalConfigStore();
const attachmentStore = new AttachmentStore(path.join(os.homedir(), ".orbit"));

// --- Runtime availability ---
const PROBE_INTERVAL_MS = Number(process.env.ORBIT_RUNTIME_PROBE_INTERVAL_MS ?? 60000);
const START_RETRY_DELAY_MS = 500;
const AUTO_PORT_RETRY_LIMIT = 10;
const SHUTDOWN_FORCE_EXIT_MS = 2000;
let runtimeAvailability: Map<string, RuntimeProbeResult> = new Map();
let probeTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;
const modelProbeStates = new Map<string, Map<AgentConfig["runtime"], AgentModelProbeState>>();

async function probeRuntimes(): Promise<void> {
  const results = await probeAllRuntimes();
  let changed = false;
  for (const result of results) {
    const previous = runtimeAvailability.get(result.runtime);
    if (!previous || previous.available !== result.available) {
      changed = true;
    }
    runtimeAvailability.set(result.runtime, result);
  }
  console.log(
    "[orbit] runtime availability: " +
    results.map((r) => `${r.runtime}=${r.available ? "found" : "missing"}`).join(", "),
  );
  if (changed) {
    sseHub.publish({ type: "runtime.availability.updated", availability: getRuntimeAvailabilityArray() });
  }
}

async function probeConfiguredAgentModels(
  force = false,
  runtimeFilter?: AgentConfig["runtime"],
  targetAgentId?: string,
  targetWorkspaceId?: string,
  targetConversationId?: string,
): Promise<void> {
  const workspaceId = targetWorkspaceId || activeWorkspaceId;
  if (!workspaceId) return;
  const workspace = workspaceStore.get(workspaceId);
  if (!workspace) return;

  const existing = agentModelStateStore.load(workspaceId);
  const targetsByRuntime = new Map<AgentConfig["runtime"], Array<Pick<AgentConfig, "id" | "runtime">>>();
  if (runtimeFilter && targetAgentId) {
    targetsByRuntime.set(runtimeFilter, [{ id: targetAgentId, runtime: runtimeFilter }]);
  } else {
    for (const config of configStore.load(workspaceId)) {
      if (runtimeFilter && config.runtime !== runtimeFilter) continue;
      const snapshot = existing[config.id];
      const probeState = modelProbeStates.get(workspaceId)?.get(config.runtime);
      if (!force && snapshot?.runtimeKind === config.runtime && probeState?.status !== "error") continue;
      const targets = targetsByRuntime.get(config.runtime) ?? [];
      targets.push(config);
      targetsByRuntime.set(config.runtime, targets);
    }
  }

  await Promise.all([...targetsByRuntime.entries()].map(async ([runtimeKind, targets]) => {
    const registration = defaultAcpRunnerRegistry.get(runtimeKind);
    if (!registration) {
      setModelProbeState(workspaceId, runtimeKind, {
        runtimeKind,
        status: "error",
        message: "该运行时不可用。",
      });
      return;
    }
    setModelProbeState(workspaceId, runtimeKind, { runtimeKind, status: "loading" });
    try {
      const first = targets[0]!;
      const snapshot = await probeAcpModelState(registration.definition, {
        agentId: first.id,
        cwd: workspace.path,
      });
      if (!snapshot) {
        setModelProbeState(workspaceId, runtimeKind, {
          runtimeKind,
          status: "unsupported",
          message: "该运行时未提供可选模型列表。",
        });
        return;
      }
      setModelProbeState(workspaceId, runtimeKind, {
        runtimeKind,
        status: snapshot.choices.length > 0 ? "ready" : "unsupported",
        ...(snapshot.choices.length === 0 ? { message: "该运行时未提供可选模型列表。" } : {}),
        updatedAt: snapshot.updatedAt,
      });
      for (const target of targets) {
        // 监工快照按会话隔离（issue #153）：存储键带会话后缀，
        // 事件带 conversationId 以便 SSE 按页面过滤。
        const isSupervisor = target.id === INTERNAL_SUPERVISOR_ID && targetConversationId !== undefined;
        const storageKey = isSupervisor ? supervisorStorageKey(targetConversationId!) : target.id;
        const previous = existing[storageKey];
        const hasSessionValue = previous?.runtimeKind === runtimeKind && previous.currentValueSource === "session";
        const targetSnapshot = {
          ...snapshot,
          agentId: target.id,
          currentValue: hasSessionValue ? previous.currentValue : undefined,
          currentValueSource: hasSessionValue ? "session" as const : "probe" as const,
        };
        agentModelStateStore.update(workspaceId, targetSnapshot, storageKey);
        sseHub.publish({
          type: "agent.model_state",
          workspaceId,
          agentId: target.id,
          modelState: targetSnapshot,
          ...(isSupervisor ? { conversationId: targetConversationId! } : {}),
        });
      }
    } catch (error) {
      setModelProbeState(workspaceId, runtimeKind, {
        runtimeKind,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      console.warn(
        `[orbit] model discovery failed for ${registration.definition.displayName}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }));
}

function setModelProbeState(workspaceId: string, runtime: AgentConfig["runtime"], state: AgentModelProbeState): void {
  const states = modelProbeStates.get(workspaceId) ?? new Map<AgentConfig["runtime"], AgentModelProbeState>();
  states.set(runtime, state);
  modelProbeStates.set(workspaceId, states);
}

function modelProbeStateFor(
  workspaceId: string,
  runtime: AgentConfig["runtime"],
  snapshot?: AgentModelWithState,
): AgentModelProbeState {
  const known = modelProbeStates.get(workspaceId)?.get(runtime);
  if (known) return known;
  if (snapshot?.runtimeKind === runtime) {
    return {
      runtimeKind: runtime,
      status: snapshot.choices.length > 0 ? "ready" : "unsupported",
      ...(snapshot.choices.length === 0 ? { message: "该运行时未提供可选模型列表。" } : {}),
      updatedAt: snapshot.updatedAt,
    };
  }
  return { runtimeKind: runtime, status: "idle" };
}

type AgentModelWithState = NonNullable<AgentConfigWithModelState["modelState"]>;

function configsWithModelState(workspaceId: string): AgentConfigWithModelState[] {
  const modelStates = agentModelStateStore.load(workspaceId);
  return configStore.load(workspaceId).map((config) => ({
    ...config,
    modelState: modelStates[config.id],
    modelProbe: modelProbeStateFor(workspaceId, config.runtime, modelStates[config.id]),
  }));
}

function startPeriodicProbe(): void {
  if (probeTimer) return;
  probeTimer = setInterval(() => {
    probeRuntimes().catch((err) => {
      console.warn("[orbit] periodic runtime probe failed:", err instanceof Error ? err.message : String(err));
    });
  }, PROBE_INTERVAL_MS);
  // Prevent timer from keeping the process alive during tests
  if (probeTimer && typeof probeTimer === "object" && "unref" in probeTimer) {
    (probeTimer as NodeJS.Timeout).unref();
  }
}

function stopPeriodicProbe(): void {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

function getRuntimeAvailabilityArray(): RuntimeProbeResult[] {
  return Array.from(runtimeAvailability.values());
}

function runtimeAvailable(runtime: string): boolean {
  const result = runtimeAvailability.get(runtimeKindToCliKey(runtime));
  return result?.available ?? false;
}

// Add the owning workspace at the server boundary so older core components can
// keep publishing conversation events without knowing transport concerns.
eventBus.subscribe((event) => {
  if (event.type === "runtime.activity") return;
  let scopedEvent = event;
  if (event.type !== "events.gap" && "conversationId" in event && event.workspaceId === undefined) {
    // agent.model_state 的 conversationId 是可选的（issue #153），缺失时不做推断。
    const eventConversationId = event.conversationId;
    if (eventConversationId !== undefined) {
      const matches = [...contextMap.keys()].filter((key) => key.endsWith(`:${eventConversationId}`));
      // An unscoped legacy event is safe to infer only when the conversation id
      // is unique in this process. Otherwise dropping it is safer than leaking
      // one workspace's activity into another page.
      if (matches.length === 1) {
        const key = matches[0]!;
        scopedEvent = { ...event, workspaceId: key.slice(0, key.length - eventConversationId.length - 1) };
      } else if (matches.length > 1) {
        return;
      }
    }
  }
  sseHub.publish(scopedEvent);
  // After agent.status events, push running.updated if summaries changed
  if (event.type === "agent.status") {
    pushRunningSummaries();
  }
});

let lastRunningSummariesJson = "";

function pushRunningSummaries(): void {
  const summaries = buildRunningSummaries();
  const json = JSON.stringify(summaries);
  if (json !== lastRunningSummariesJson) {
    lastRunningSummariesJson = json;
    sseHub.publish({ type: "running.updated", summaries });
  }
}

// --- Last-active persistence ---
type LastActive = { workspaceId: string; conversationId: string };
const lastActivePath = path.join(os.homedir(), ".orbit", "last-active.json");

function loadLastActive(): LastActive | null {
  try {
    return JSON.parse(fs.readFileSync(lastActivePath, "utf8")) as LastActive;
  } catch {
    return null;
  }
}

function saveLastActive(workspaceId: string, conversationId: string): void {
  const dir = path.dirname(lastActivePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = lastActivePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ workspaceId, conversationId }, null, 2) + os.EOL);
  fs.renameSync(tmp, lastActivePath);
}

function clearLastActive(): void {
  try {
    fs.rmSync(lastActivePath, { force: true });
  } catch {
    // best effort
  }
}

// --- Active context state ---
let activeWorkspaceId = "";
let activeConversationId = "";
let activeWorkspace: WorkspaceInfo = EMPTY_WORKSPACE;
let activeConversation: ConversationInfo = EMPTY_CONVERSATION;
let allConfigs: AgentConfig[] = [];
let conversationStore: ConversationStore;
let sessionStore: SessionStore | null = null;

// --- Context map (multi-conversation parallel support) ---
const MAX_ACTIVE_CONTEXTS = 10;
const contextMap = new Map<string, ConversationContext>();
const contextLru: string[] = [];

function contextKey(workspaceId: string, conversationId: string): string {
  return `${workspaceId}:${conversationId}`;
}

/** Resolve page-owned context. Query parameters are the public API contract;
 * the active pointers are retained only as a compatibility fallback for old clients. */
function resolveTargetDetailed(url: URL, requireConversation = true) {
  return resolveTargetDetails(
    url,
    { activeWorkspaceId, activeConversationId },
    {
      workspace: (id) => Boolean(workspaceStore.get(id)),
      conversation: (ws, conv) => Boolean(conversationStore.get(ws, conv)),
    },
    requireConversation,
  );
}

function resolveTarget(url: URL, requireConversation = true): RequestTarget | null {
  return resolveTargetDetailed(url, requireConversation).target;
}

/** 上传类端点的目标缺失文案：未知会话是 404（与 /api/messages 一致），
 * 无会话/无工作区是 409（调用方补齐上下文后可重试）。 */
const TARGET_MISSING_MESSAGES: Record<TargetMissingReason, string> = {
  missing_workspace: "请先选择或创建工作区，再上传附件。",
  missing_conversation: "当前没有可接收附件的会话，请先创建或选择一个会话。",
  unknown_conversation: "会话不存在或已被删除。",
};

function contextForTarget(target: RequestTarget | null): ConversationContext | null {
  if (!target) return null;
  if (!target.workspaceId || !target.conversationId) return null;
  if (!workspaceStore.get(target.workspaceId) || !conversationStore.get(target.workspaceId, target.conversationId)) return null;
  return getOrCreateContext(target.workspaceId, target.conversationId);
}

function conversationStoreFor(workspaceId: string): ConversationStore {
  return workspaceId === activeWorkspaceId ? conversationStore : new ConversationStore();
}

function getOrCreateContext(workspaceId: string, conversationId: string): ConversationContext {
  const key = contextKey(workspaceId, conversationId);
  const existing = contextMap.get(key);
  if (existing) {
    touchLru(key);
    return existing;
  }
  evictIfNeeded();
  const ctx = createContext(workspaceId, conversationId);
  contextMap.set(key, ctx);
  touchLru(key);
  return ctx;
}

function touchLru(key: string): void {
  const idx = contextLru.indexOf(key);
  if (idx !== -1) contextLru.splice(idx, 1);
  contextLru.push(key);
}

function evictIfNeeded(): void {
  while (contextMap.size >= MAX_ACTIVE_CONTEXTS) {
    let evicted = false;
    for (const key of contextLru) {
      const ctx = contextMap.get(key);
      if (ctx && !ctx.hasRunningOrQueued()) {
        ctx.dispose();
        contextMap.delete(key);
        const idx = contextLru.indexOf(key);
        if (idx !== -1) contextLru.splice(idx, 1);
        evicted = true;
        break;
      }
    }
    if (!evicted) {
      console.warn("[orbit] LRU eviction skipped: all active contexts have running agents");
      break;
    }
  }
}

function disposeContext(workspaceId: string, conversationId: string): void {
  const key = contextKey(workspaceId, conversationId);
  const ctx = contextMap.get(key);
  if (ctx) {
    ctx.dispose();
    contextMap.delete(key);
    const idx = contextLru.indexOf(key);
    if (idx !== -1) contextLru.splice(idx, 1);
  }
}

function disposeWorkspaceContexts(workspaceId: string): void {
  const keysToRemove: string[] = [];
  for (const key of contextMap.keys()) {
    if (key.startsWith(`${workspaceId}:`)) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    contextMap.get(key)?.dispose();
    contextMap.delete(key);
    const idx = contextLru.indexOf(key);
    if (idx !== -1) contextLru.splice(idx, 1);
  }
}

function createContext(workspaceId: string, conversationId: string): ConversationContext {
  const configs = configStore.load(workspaceId);
  const enabledConfigs = configs.filter((c) => c.enabled);
  const ws = workspaceStore.get(workspaceId);
  const profiles = configsToProfiles(enabledConfigs, ws!.path);
  const sessStore = new SessionStore(workspaceStore.sessionsDir(workspaceId));
  const workspaceConfig = workspaceConfigStore.load(workspaceId);
  const conversation = conversationStoreFor(workspaceId).get(workspaceId, conversationId);
  return new ConversationContext({
    workspaceId,
    conversationId,
    profiles,
    eventBus,
    sessionStore: sessStore,
    workspaceStore,
    workspaceConfig,
    globalConfig: globalConfigStore.load(),
    interactionMode: conversation?.interactionMode,
    supervisorConfig: conversation?.supervisorConfig,
    lastDirectAgentId: conversation?.lastDirectAgentId,
    // 模型快照桥（issue #142）：runtime 返回的模型列表/当前值写穿到 workspace
    // 级存储，同时广播给 UI；读取供池复用捷径补发偏好。
    // 监工按会话隔离（issue #153）：所有会话共用 agentId "supervisor"，
    // 存储键须带会话后缀，事件须带 conversationId 才能按页面过滤。
    modelState: {
      load: (agentId) => agentModelStateStore.get(
        workspaceId,
        agentId === INTERNAL_SUPERVISOR_ID ? supervisorStorageKey(conversationId) : agentId,
      ),
      update: (snapshot) => {
        const isSupervisor = snapshot.agentId === INTERNAL_SUPERVISOR_ID;
        agentModelStateStore.update(
          workspaceId,
          snapshot,
          isSupervisor ? supervisorStorageKey(conversationId) : snapshot.agentId,
        );
        sseHub.publish({
          type: "agent.model_state",
          workspaceId,
          agentId: snapshot.agentId,
          modelState: snapshot,
          ...(isSupervisor ? { conversationId } : {}),
        });
      },
    },
    onConversationPatch: (patch) => {
      try {
        const store = workspaceId === activeWorkspaceId ? conversationStore : new ConversationStore();
        const updated = store.update(workspaceId, conversationId, patch);
        if (workspaceId === activeWorkspaceId && conversationId === activeConversationId) {
          activeConversation = toActiveConversation(updated);
        }
      } catch {
        // 持久化失败不阻断路由流程；模式仍在本会话上下文中生效
      }
    },
  });
}

function getActiveContext(): ConversationContext | null {
  if (!activeWorkspaceId || !activeConversationId) return null;
  return contextMap.get(contextKey(activeWorkspaceId, activeConversationId)) ?? null;
}

function buildRunningSummaries(): RunningSummary[] {
  const summaries: RunningSummary[] = [];
  for (const [key, ctx] of contextMap) {
    const running = ctx.agents.states().filter((s) => s.status === "running").map((s) => s.id);
    if (running.length > 0) {
      const separatorIdx = key.indexOf(":");
      const wsId = key.slice(0, separatorIdx);
      const convId = key.slice(separatorIdx + 1);
      summaries.push({ workspaceId: wsId, conversationId: convId, runningAgentIds: running });
    }
  }
  return summaries;
}

// --- Context lifecycle ---

function initActiveContext(): void {
  conversationStore = new ConversationStore();

  const last = loadLastActive();
  if (!last) {
    return;
  }

  const ws = workspaceStore.get(last.workspaceId);
  if (!ws) {
    clearLastActive();
    return;
  }

  activeWorkspaceId = ws.id;
  activeWorkspace = { id: ws.id, name: ws.name, path: ws.path };
  workspaceStore.touchLastOpened(activeWorkspaceId);
  sessionStore = new SessionStore(workspaceStore.sessionsDir(activeWorkspaceId));
  allConfigs = configStore.load(activeWorkspaceId);

  const conversation = last.conversationId ? conversationStore.get(activeWorkspaceId, last.conversationId) : null;
  if (conversation) {
    activateConversation(conversation);
  } else {
    activeConversationId = "";
    activeConversation = EMPTY_CONVERSATION;
    saveLastActive(activeWorkspaceId, activeConversationId);
  }
}

function activateConversation(conversation: Conversation, shouldTouchLastOpened = true): void {
  // No dispose of old context — it stays alive in the map for parallel execution
  activeConversationId = conversation.id;
  activeConversation = toActiveConversation(conversation);

  // Issue #77: Only touch lastOpenedAt when creating a conversation or first opening it,
  // not when switching between existing conversations. This prevents the conversation
  // list from reordering when the user simply clicks to view a different conversation.
  if (shouldTouchLastOpened) {
    conversationStore.touchLastOpened(activeWorkspaceId, activeConversationId);
  }

  saveLastActive(activeWorkspaceId, activeConversationId);
  // Ensure context exists in map (creates lazily if needed)
  getOrCreateContext(activeWorkspaceId, activeConversationId);
}

function switchWorkspace(workspaceId: string): void {
  if (workspaceId === activeWorkspaceId) return;
  // No running-agent check — agents continue in background

  const ws = workspaceStore.get(workspaceId);
  if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);

  activeWorkspaceId = workspaceId;
  activeWorkspace = { id: ws.id, name: ws.name, path: ws.path };
  workspaceStore.touchLastOpened(workspaceId);

  sessionStore = new SessionStore(workspaceStore.sessionsDir(activeWorkspaceId));
  conversationStore = new ConversationStore();
  allConfigs = configStore.load(activeWorkspaceId);

  activeConversationId = "";
  activeConversation = EMPTY_CONVERSATION;
  saveLastActive(activeWorkspaceId, activeConversationId);

}

function refreshEnabledAgentsForWorkspace(workspaceId: string, configs: AgentConfig[]): void {
  const workspace = workspaceStore.get(workspaceId);
  if (!workspace) return;
  const enabledConfigs = configs.filter((c) => c.enabled);
  const profiles = configsToProfiles(enabledConfigs, workspace.path);

  // Refresh profiles for ALL contexts in the same workspace, not just the active one
  for (const [key, ctx] of contextMap) {
    if (key.startsWith(`${workspaceId}:`)) {
      ctx.refreshProfiles(profiles);
    }
  }
}

function clearActiveContext(): void {
  disposeWorkspaceContexts(activeWorkspaceId);
  activeWorkspaceId = "";
  activeConversationId = "";
  activeWorkspace = EMPTY_WORKSPACE;
  activeConversation = EMPTY_CONVERSATION;
  allConfigs = [];
  sessionStore = null;
  clearLastActive();
}

function clearActiveConversation(): void {
  // Don't dispose — just clear the active pointer
  activeConversationId = "";
  activeConversation = EMPTY_CONVERSATION;
  saveLastActive(activeWorkspaceId, activeConversationId);
}

/**
 * 附件下载名：优先使用会话消息历史里记录的用户原始文件名；存储文件名是
 * `<id>.<ext>`，直接下发会让"用户说明.txt"下载成 UUID 名。
 *
 * 展示文件名存在附件目录的索引里（commit 时写入），下载只读这个小文件；
 * 早于索引的历史附件才扫描一次历史并回填，避免每次下载都同步读取全部
 * 历史分片（长会话单次上百毫秒，一条多图消息会阻塞事件循环）。
 */
async function resolveAttachmentFilename(
  workspaceId: string,
  conversationId: string,
  attachmentId: string,
): Promise<string | null> {
  const indexed = await attachmentStore.attachmentFilename(workspaceId, conversationId, attachmentId);
  if (indexed) return indexed;

  const ctx = contextMap.get(contextKey(workspaceId, conversationId));
  const scanned = ctx
    ? ctx.messages.attachmentFilename(attachmentId)
    // 该会话当前没有活动上下文：只读打开消息历史，不做任何写入。
    : new MessageStore(
      path.join(workspaceStore.channelsDir(workspaceId, conversationId), "messages.json"),
      { historyRead: true },
    ).attachmentFilename(attachmentId);
  if (scanned) {
    await attachmentStore.rememberAttachmentFilename(workspaceId, conversationId, attachmentId, scanned);
  }
  return scanned;
}

function currentAgentStates() {
  const ctx = getActiveContext();
  if (ctx) {
    return ctx.agents.states().map((s) => ({
      ...s,
      runtimeAvailable: runtimeAvailable(s.runtime),
    }));
  }
  return allConfigs
    .filter((config) => config.enabled)
    .map((config, index) => ({
      id: config.id,
      label: config.name,
      runtime: config.runtime,
      status: "idle" as const,
      selected: index === 0,
      runtimeAvailable: runtimeAvailable(config.runtime),
    }));
}

// --- Initialize ---
migrateChannelLayer();
initActiveContext();
runHistoryCleanup();
runAttachmentDraftCleanup();

/**
 * 解析并校验监工配置（issue #153）。
 *
 * 模型取值不在当前列表里时不拒绝保存：运行时会在应用时提示并回退，
 * 提前拒绝会让用户在模型列表刷新不出来时无法保存其他改动。
 */
function parseSupervisorConfig(input: { runtime?: unknown; model?: unknown }):
  { config: SupervisorConfig } | { error: string } {
  if (!isAgentRuntimeKind(input.runtime)) {
    return { error: "监工运行时必须是 claude-code、codex 或 codebuddy。" };
  }
  const runtime = input.runtime;
  if (input.model === undefined || input.model === null) return { config: { runtime } };
  if (typeof input.model !== "object" || Array.isArray(input.model)) {
    return { error: "监工模型配置格式不正确。" };
  }
  const model = input.model as { preferredModelId?: unknown; runtimeKind?: unknown };
  if (model.runtimeKind !== undefined && !isAgentRuntimeKind(model.runtimeKind)) {
    return { error: "监工模型配置格式不正确。" };
  }
  if (model.preferredModelId !== undefined
    && model.preferredModelId !== null
    && typeof model.preferredModelId !== "string") {
    return { error: "监工模型配置格式不正确。" };
  }
  const preferredModelId = typeof model.preferredModelId === "string"
    ? model.preferredModelId.trim()
    : "";
  if (preferredModelId.length > 512) {
    return { error: "监工模型标识过长。" };
  }
  if (!preferredModelId) return { config: { runtime } };
  return {
    config: {
      runtime,
      model: { preferredModelId, runtimeKind: isAgentRuntimeKind(model.runtimeKind) ? model.runtimeKind : runtime },
    },
  };
}

// --- HTTP Server (created before probe to avoid blocking setup) ---
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // SSE
    if (req.method === "GET" && url.pathname === "/events") {
      const lastEventId = Number(req.headers["last-event-id"]);
      sseHub.add(res, {
        workspaceId: url.searchParams.get("workspaceId") || undefined,
        conversationId: url.searchParams.get("conversationId") || undefined,
      }, Number.isFinite(lastEventId) ? lastEventId : undefined);
      return;
    }

    // State
    if (req.method === "GET" && url.pathname === "/api/state") {
      const target = resolveTarget(url, false);
      const ctx = target?.conversationId ? contextForTarget(target) : null;
      const workspace = target ? workspaceStore.get(target.workspaceId) : null;
      const conversation = target?.conversationId ? conversationStoreFor(target.workspaceId).get(target.workspaceId, target.conversationId) : null;
      const messages = ctx?.messages.list() ?? [];
      sendJson(res, 200, {
        workspace: workspace ? { id: workspace.id, name: workspace.name, path: workspace.path } : EMPTY_WORKSPACE,
        conversation: conversation ? toActiveConversation(conversation) : EMPTY_CONVERSATION,
        agents: ctx ? ctx.agents.states().map((s) => ({ ...s, runtimeAvailable: runtimeAvailable(s.runtime) })) : (target ? configsWithModelState(target.workspaceId).filter((c) => c.enabled).map((c, i) => ({ id: c.id, label: c.name, runtime: c.runtime, status: "idle" as const, selected: i === 0, runtimeAvailable: runtimeAvailable(c.runtime) })) : currentAgentStates()),
        messages: ctx?.runManager.projectLiveProcessState(messages) ?? messages,
        messageHistory: ctx?.messages.historyState() ?? emptyMessageHistory(),
        terminal: ctx?.transcripts.all() ?? {},
        runningSummaries: buildRunningSummaries(),
        runtimeAvailability: getRuntimeAvailabilityArray(),
        pendingPermissions: ctx?.pendingPermissions() ?? [],
        pendingElicitations: ctx?.pendingElicitations() ?? [],
        agentCommands: ctx?.availableCommands() ?? {},
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/work-analysis") {
      const workspaceId = url.searchParams.get("workspaceId") || activeWorkspaceId;
      if (!workspaceId || !workspaceStore.get(workspaceId)) {
        sendJson(res, 409, { ok: false, message: "Create or select a workspace before viewing work analysis." });
        return;
      }
      const requestedDays = Number(url.searchParams.get("days") ?? 30);
      const days = Number.isFinite(requestedDays) ? Math.max(1, Math.min(365, Math.floor(requestedDays))) : 30;
      sendJson(res, 200, buildWorkspaceWorkAnalysis({
        workspaceId,
        days,
        workspaceStore,
        conversationStore: conversationStoreFor(workspaceId),
        agentConfigStore: configStore,
      }));
      return;
    }

    // Messages
    if (req.method === "GET" && url.pathname === "/api/messages") {
      const target = resolveTarget(url);
      const ctx = target?.conversationId ? contextForTarget(target) : null;
      if (!ctx) {
        sendJson(res, 200, emptyMessagePage());
        return;
      }
      const before = url.searchParams.get("before");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      sendJson(res, 200, ctx.messages.listBefore(before, Number.isFinite(limit) ? limit : 50));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/messages") {
      await handlePostMessage(req, res, url);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/permissions/resolve") {
      const input = (await readJson(req)) as { requestId?: unknown; decision?: unknown };
      const requestId = typeof input.requestId === "string" ? input.requestId : "";
      const decision = input.decision === "allow" || input.decision === "reject"
        ? input.decision as PermissionDecision
        : null;
      if (!requestId || !decision) {
        sendJson(res, 400, { ok: false, message: "A valid requestId and decision are required." });
        return;
      }
      const ctx = contextForTarget(resolveTarget(url));
      if (!ctx?.resolvePermission(requestId, decision)) {
        sendJson(res, 404, { ok: false, message: "Permission request is no longer pending." });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/elicitations/resolve") {
      const input = await readJson(req);
      const requestId = isRecord(input) && typeof input.requestId === "string" ? input.requestId : "";
      const response = parseElicitationResponse(input);
      if (!requestId || !response) {
        sendJson(res, 400, { ok: false, message: "A valid requestId and elicitation response are required." });
        return;
      }
      const ctx = contextForTarget(resolveTarget(url));
      if (!ctx?.resolveElicitation(requestId, response)) {
        sendJson(res, 404, { ok: false, message: "Elicitation request is no longer pending." });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // Interrupt current auto-collaboration chain
    if (req.method === "POST" && url.pathname === "/api/conversation/interrupt") {
      const ctx = contextForTarget(resolveTarget(url));
      if (!ctx) {
        sendJson(res, 409, { ok: false, message: "No active conversation." });
        return;
      }
      const result = ctx.interrupt();
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    // --- Attachment endpoints ---

    if (req.method === "POST" && url.pathname === "/api/attachments/drafts") {
      // 目标来自请求 query 快照（#155 页面上下文契约）：上传进行中切换
      // 会话时，文件仍保存到发起上传的会话目录，不会错投到新会话。
      const resolution = resolveTargetDetailed(url);
      if (!resolution.target) {
        // #7：未知会话是 404（与 /api/messages 一致），没有会话/工作区是 409。
        sendJson(res, resolution.reason === "unknown_conversation" ? 404 : 409, {
          ok: false,
          message: TARGET_MISSING_MESSAGES[resolution.reason],
        });
        return;
      }
      const target = resolution.target;
      const input = (await readJson(req)) as {
        data?: unknown;
        mimeType?: unknown;
        filename?: unknown;
      };
      const base64Data = typeof input.data === "string" ? input.data : "";
      const mimeType = typeof input.mimeType === "string" ? input.mimeType : "";
      const filename = typeof input.filename === "string" ? input.filename : "";

      if (!base64Data) {
        sendJson(res, 400, { ok: false, message: "附件内容为空，请重新选择文件。" });
        return;
      }

      const buffer = Buffer.from(base64Data, "base64");
      const validation = AttachmentStore.validateUpload(buffer, mimeType, filename);
      if (!validation.valid) {
        sendJson(res, 400, { ok: false, message: validation.error });
        return;
      }
      const validated = validation.attachment;

      // Issue #88: 计数与写入在同一段互斥区内完成，并发上传无法绕过上限。
      const saved = await attachmentStore.saveDraftWithinLimit({
        workspaceId: target.workspaceId,
        conversationId: target.conversationId,
        data: buffer,
        ext: validated.ext,
        filename: validated.filename,
      });
      if (!saved.ok) {
        sendJson(res, 400, {
          ok: false,
          message: `待上传附件过多（上限 ${saved.limit} 个），请先发送或删除已有附件。`,
        });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        attachment: {
          id: saved.id,
          kind: validated.kind,
          mimeType: validated.mimeType,
          filename: validated.filename,
          size: saved.size,
          ...(validated.kind === "image"
            ? { previewUrl: `/api/attachments/drafts/${target.workspaceId}/${target.conversationId}/${saved.id}` }
            : {}),
        },
      });
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/attachments/drafts/")) {
      const parts = url.pathname.split("/");
      // /api/attachments/drafts/:workspaceId/:conversationId/:id
      const wsId = parts[4];
      const convId = parts[5];
      const draftId = parts[6];
      if (!wsId || !convId || !draftId) {
        sendJson(res, 400, { ok: false, message: "Missing draft parameters." });
        return;
      }
      const deleted = await attachmentStore.deleteDraft(wsId, convId, draftId);
      sendJson(res, 200, { ok: true, deleted });
      return;
    }

    // GET draft attachments for preview in composer
    if (req.method === "GET" && url.pathname.startsWith("/api/attachments/drafts/")) {
      const parts = url.pathname.split("/");
      // /api/attachments/drafts/:workspaceId/:conversationId/:id
      const wsId = parts[4];
      const convId = parts[5];
      const draftId = parts[6];
      if (!wsId || !convId || !draftId) {
        sendJson(res, 400, { ok: false, message: "Missing draft parameters." });
        return;
      }
      const draft = await attachmentStore.getDraft(wsId, convId, draftId);
      if (!draft) {
        sendJson(res, 404, { ok: false, message: "Draft not found." });
        return;
      }
      res.writeHead(200, buildAttachmentHeaders(draft));
      res.end(draft.data);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/attachments/")) {
      const parts = url.pathname.split("/");
      // /api/attachments/:workspaceId/:conversationId/:id
      const wsId = parts[3];
      const convId = parts[4];
      const attachId = parts[5];
      if (!wsId || !convId || !attachId) {
        sendJson(res, 400, { ok: false, message: "Missing attachment parameters." });
        return;
      }
      const attachment = await attachmentStore.getAttachment(wsId, convId, attachId);
      if (!attachment) {
        sendJson(res, 404, { ok: false, message: "Attachment not found." });
        return;
      }
      const displayFilename = await resolveAttachmentFilename(wsId, convId, attachId) ?? attachment.filename;
      res.writeHead(200, buildAttachmentHeaders({ ...attachment, filename: displayFilename }));
      res.end(attachment.data);
      return;
    }

    // Cancel run (queued or running)
    if (req.method === "POST" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/cancel")) {
      const parts = url.pathname.split("/");
      const runId = parts[3];
      if (!runId) {
        sendJson(res, 400, { ok: false, message: "Missing run id." });
        return;
      }

      // 定向取消：只作用于本页面的会话上下文，不再遍历全部上下文
      const target = resolveTarget(url);
      if (!target) {
        sendJson(res, 409, { ok: false, message: "workspaceId and conversationId are required." });
        return;
      }
      const ctx = contextForTarget(target);
      const result: { ok: boolean; reason?: string } = ctx?.runManager.cancel(runId) ?? { ok: false, reason: "not_found" };
      if (!result.ok) {
        if (result.reason === "not_cancellable") {
          sendJson(res, 409, { ok: false, reason: "not_cancellable", message: "This run has already finished and cannot be cancelled." });
        } else {
          sendJson(res, 404, { ok: false, reason: "not_found", message: "Run not found." });
        }
        return;
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    // Agents
    if (req.method === "GET" && url.pathname === "/api/agents") {
      // 合并 workspace 级模型快照（issue #142）：模型列表/当前值由 runtime 在
      // 运行时写入独立存储，agents.json 只保存用户偏好。
      const workspaceId = url.searchParams.get("workspaceId") || activeWorkspaceId;
      sendJson(res, 200, workspaceId ? configsWithModelState(workspaceId) : allConfigs);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agents/probe-models") {
      const runtimeParam = url.searchParams.get("runtime");
      const runtimeFilter = runtimeParam as AgentConfig["runtime"] | null;
      const targetAgentId = url.searchParams.get("agentId")?.trim();
      if (runtimeFilter && !defaultAcpRunnerRegistry.get(runtimeFilter)) {
        sendJson(res, 400, { ok: false, message: "未知的运行时。" });
        return;
      }
      if (targetAgentId && (!runtimeFilter || !/^[a-zA-Z0-9_-]{1,128}$/.test(targetAgentId))) {
        sendJson(res, 400, { ok: false, message: "刷新指定员工模型时需要有效的员工 ID 和运行时。" });
        return;
      }
      const targetConversationId = url.searchParams.get("conversationId")?.trim() || undefined;
      // 监工是内部保留 ID，所有会话共用；缺会话维度会读写到别的会话的快照。
      if (targetAgentId === INTERNAL_SUPERVISOR_ID && !targetConversationId) {
        sendJson(res, 400, { ok: false, message: "刷新监工模型列表时需要会话 ID。" });
        return;
      }
      await probeConfiguredAgentModels(
        url.searchParams.get("force") === "1",
        runtimeFilter ?? undefined,
        targetAgentId,
        url.searchParams.get("workspaceId") || undefined,
        targetConversationId,
      );
      const workspaceId = url.searchParams.get("workspaceId") || activeWorkspaceId;
      const configs = workspaceId ? configsWithModelState(workspaceId) : allConfigs;
      const response: AgentModelProbeResponse = { configs };
      if (workspaceId && runtimeFilter && targetAgentId) {
        const snapshot = agentModelStateStore.get(
          workspaceId,
          targetAgentId === INTERNAL_SUPERVISOR_ID && targetConversationId
            ? supervisorStorageKey(targetConversationId)
            : targetAgentId,
        );
        const matchingSnapshot = snapshot?.runtimeKind === runtimeFilter ? snapshot : undefined;
        response.target = {
          agentId: targetAgentId,
          runtimeKind: runtimeFilter,
          modelState: matchingSnapshot ?? null,
          modelProbe: modelProbeStateFor(workspaceId, runtimeFilter, matchingSnapshot),
        };
      }
      sendJson(res, 200, response);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent-teams") {
      sendJson(res, 200, AGENT_TEAM_TEMPLATES);
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/agents") {
      await handlePutAgents(req, res, url);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agents/reset") {
      const workspaceId = url.searchParams.get("workspaceId") || activeWorkspaceId;
      if (!workspaceId || !workspaceStore.get(workspaceId)) {
        sendJson(res, 409, { ok: false, message: "Create or select a workspace before resetting agents." });
        return;
      }
      if ([...contextMap].some(([key, value]) => key.startsWith(`${workspaceId}:`) && value.hasRunningOrQueued())) {
        sendJson(res, 409, { ok: false, message: "Cannot reset while an agent is running. Wait for it to finish." });
        return;
      }
      const configs = configStore.reset(workspaceId);
      refreshEnabledAgentsForWorkspace(workspaceId, configs);
      sendJson(res, 200, configs);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agents/apply-team") {
      const workspaceId = url.searchParams.get("workspaceId") || activeWorkspaceId;
      if (!workspaceId || !workspaceStore.get(workspaceId)) {
        sendJson(res, 409, { ok: false, message: "Create or select a workspace before applying a team." });
        return;
      }
      if ([...contextMap].some(([key, value]) => key.startsWith(`${workspaceId}:`) && value.hasRunningOrQueued())) {
        sendJson(res, 409, { ok: false, message: "Cannot change the team while an agent is running." });
        return;
      }
      const input = (await readJson(req)) as { teamId?: unknown };
      const template = AGENT_TEAM_TEMPLATES.find((item) => item.id === input.teamId);
      if (!template) {
        sendJson(res, 400, { ok: false, message: "Unknown team template." });
        return;
      }
      // 数字员工尽量使用本地实际可用的不同运行时（按 AGENT_RUNTIME_PRIORITY 轮流分配）。
      const configs = initialAgentConfigsForWorkspacePreset(template.id, getRuntimeAvailabilityArray()) ?? [];
      configStore.save(workspaceId, configs);
      refreshEnabledAgentsForWorkspace(workspaceId, configs);
      sendJson(res, 200, configs);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/runtimes/probe") {
      await probeRuntimes();
      sendJson(res, 200, { ok: true, availability: getRuntimeAvailabilityArray() });
      return;
    }

    // --- Workspace config ---
    if (req.method === "GET" && url.pathname === "/api/workspace-presets") {
      sendJson(res, 200, getWorkspacePresets());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace-config") {
      const workspaceId = url.searchParams.get("workspaceId") || activeWorkspaceId;
      if (!workspaceId || !workspaceStore.get(workspaceId)) {
        sendJson(res, 200, { systemPrompt: "", rules: [] });
        return;
      }
      sendJson(res, 200, workspaceConfigStore.load(workspaceId));
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/workspace-config") {
      const workspaceId = url.searchParams.get("workspaceId") || activeWorkspaceId;
      if (!workspaceId || !workspaceStore.get(workspaceId)) {
        sendJson(res, 409, { ok: false, message: "Create or select a workspace before saving workspace config." });
        return;
      }
      const input = (await readJson(req)) as WorkspaceConfig;
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        sendJson(res, 400, { ok: false, message: "Request body must be a JSON object." });
        return;
      }
      if (input.rules !== undefined) {
        if (!Array.isArray(input.rules) || input.rules.some((r) => typeof r !== "string")) {
          sendJson(res, 400, { ok: false, message: "rules must be an array of strings." });
          return;
        }
      }
      if (input.systemPrompt !== undefined && typeof input.systemPrompt !== "string") {
        sendJson(res, 400, { ok: false, message: "systemPrompt must be a string." });
        return;
      }
      workspaceConfigStore.save(workspaceId, input);
      const resolved = workspaceConfigStore.load(workspaceId);
      // Update all active contexts for this workspace so the next agent run
      // immediately uses the new config.
      for (const [key, ctx] of contextMap) {
        if (key.startsWith(`${workspaceId}:`)) {
          ctx.updateWorkspaceConfig(resolved);
        }
      }
      sendJson(res, 200, resolved);
      return;
    }

    // --- Global config ---

    if (req.method === "GET" && url.pathname === "/api/global-config") {
      sendJson(res, 200, globalConfigStore.load());
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/global-config") {
      const input = (await readJson(req)) as GlobalConfig;
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        sendJson(res, 400, { ok: false, message: "Request body must be a JSON object." });
        return;
      }
      if (input.enableRunLogs !== undefined && typeof input.enableRunLogs !== "boolean") {
        sendJson(res, 400, { ok: false, message: "enableRunLogs must be a boolean." });
        return;
      }
      globalConfigStore.save(input);
      const resolved = globalConfigStore.load();
      // Update all active contexts so they use the new config
      for (const ctx of contextMap.values()) {
        ctx.updateGlobalConfig(resolved);
      }
      sendJson(res, 200, resolved);
      return;
    }

    // --- Workspace endpoints ---

    // 消息里的本地路径入口点击后在此定位（issue #143）。仅允许已配置工作区
    // 内的路径；resolve 逻辑在 local-path-reveal.ts 中独立可测。
    if (req.method === "POST" && url.pathname === "/api/local-path/reveal") {
      const input = (await readJson(req)) as { path?: unknown };
      if (typeof input.path !== "string") {
        sendJson(res, 400, { ok: false, message: "path is required." });
        return;
      }
      const roots = workspaceStore.list().map((ws) => ws.path);
      const resolution = await resolveRevealTarget(input.path, roots);
      if (!resolution.ok) {
        sendJson(res, resolution.status, { ok: false, message: resolution.message });
        return;
      }
      try {
        await revealInFileManager(resolution.target, resolution.isDirectory);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 500, { ok: false, message: `无法打开资源管理器：${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/pick-directory") {
      try {
        const directory = await pickDirectory();
        sendJson(res, 200, { path: directory });
      } catch {
        sendJson(res, 200, { path: null });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      sendJson(res, 200, workspaceStore.list());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces") {
      const input = (await readJson(req)) as { name?: unknown; path?: unknown; presetId?: unknown };
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const wsPath = typeof input.path === "string" ? input.path.trim() : "";
      const presetId = typeof input.presetId === "string" ? input.presetId.trim() : "";
      if (!wsPath) {
        sendJson(res, 400, { ok: false, message: "path is required." });
        return;
      }
      const allPresets = getWorkspacePresets();
      if (presetId && !allPresets.some((p) => p.id === presetId)) {
        sendJson(res, 400, { ok: false, message: `Unknown presetId: "${presetId}".` });
        return;
      }
      try {
        const ws = workspaceStore.create(name, wsPath);
        // Apply the requested preset's prompt/rules when a valid preset id is given.
        // The "empty" preset just writes empty values, which the config resolver
        // treats as "no injection" — equivalent to not saving.
        if (presetId) {
          const preset = allPresets.find((p) => p.id === presetId)!;
          workspaceConfigStore.save(ws.id, {
            systemPrompt: preset.systemPrompt,
            rules: preset.rules,
          });
          // 预置数字员工团队：仅当模板关联了团队时写入；空白工作区不写 agents.json，
          // 加载时回落到全禁用的默认配置，即"没有数字员工"。
          const agentConfigs = initialAgentConfigsForWorkspacePreset(preset.id, getRuntimeAvailabilityArray());
          if (agentConfigs) {
            configStore.save(ws.id, agentConfigs);
          }
        }
        sendJson(res, 200, ws);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sendJson(res, 409, { ok: false, message: msg });
      }
      return;
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/workspaces/")) {
      const parts = url.pathname.split("/");
      const wsId = parts[3];
      if (!wsId) { sendJson(res, 400, { ok: false, message: "Missing workspace id." }); return; }
      const input = (await readJson(req)) as { name?: unknown };
      const name = typeof input.name === "string" ? input.name.trim() : undefined;
      try {
        const ws = workspaceStore.update(wsId, { name });
        sendJson(res, 200, ws);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sendJson(res, 404, { ok: false, message: msg });
      }
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/workspaces/")) {
      const parts = url.pathname.split("/");
      const wsId = parts[3];
      if (!wsId) { sendJson(res, 400, { ok: false, message: "Missing workspace id." }); return; }
      // Check if ANY context for this workspace has running agents
      let hasRunning = false;
      for (const [key, ctx] of contextMap) {
        if (key.startsWith(`${wsId}:`) && ctx.hasRunningOrQueued()) {
          hasRunning = true;
          break;
        }
      }
      if (hasRunning) {
        sendJson(res, 409, { ok: false, message: "Cannot delete workspace with running agents." });
        return;
      }
      try {
        const wasActiveWorkspace = wsId === activeWorkspaceId;
        disposeWorkspaceContexts(wsId);
        attachmentStore.deleteWorkspaceDrafts(wsId).catch(() => { /* best effort */ });
        workspaceStore.delete(wsId);
        if (wasActiveWorkspace) {
          const nextWorkspace = workspaceStore.list()[0];
          if (nextWorkspace) {
            switchWorkspace(nextWorkspace.id);
          } else {
            clearActiveContext();
          }
        }
        sendJson(res, 200, { ok: true });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sendJson(res, 404, { ok: false, message: msg });
      }
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/workspaces/") && url.pathname.endsWith("/switch")) {
      const parts = url.pathname.split("/");
      const wsId = parts[3];
      if (!wsId) { sendJson(res, 400, { ok: false, message: "Missing workspace id." }); return; }
      try {
        switchWorkspace(wsId);
        sendJson(res, 200, { ok: true, workspace: activeWorkspace, conversation: activeConversation });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sendJson(res, 409, { ok: false, message: msg });
      }
      return;
    }

    // --- Conversation endpoints ---

    if (req.method === "GET" && url.pathname === "/api/conversations") {
      const workspaceId = url.searchParams.get("workspaceId") || activeWorkspaceId;
      if (!workspaceId || !workspaceStore.get(workspaceId)) {
        sendJson(res, 200, []);
        return;
      }
      sendJson(res, 200, conversationStoreFor(workspaceId).list(workspaceId));
      return;
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/workspaces\/[^/]+\/conversations$/)) {
      const parts = url.pathname.split("/");
      const wsId = parts[3];
      if (!wsId) { sendJson(res, 400, { ok: false, message: "Missing workspace id." }); return; }
      try {
        const store = conversationStoreFor(wsId);
        sendJson(res, 200, store.list(wsId));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sendJson(res, 404, { ok: false, message: msg });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/conversations") {
      // 创建会话只创建并返回资源，不激活它；页面随后通过显式上下文决定是否切换。
      const workspaceParam = url.searchParams.get("workspaceId");
      const wsId = workspaceParam === null ? activeWorkspaceId : workspaceParam.trim();
      if (!wsId) {
        sendJson(res, 409, { ok: false, message: "Create or select a workspace before creating a conversation." });
        return;
      }
      const input = (await readJson(req)) as { name?: unknown };
      const name = conversationTitle(typeof input.name === "string" ? input.name : "");
      if (!workspaceStore.get(wsId)) {
        sendJson(res, 404, { ok: false, message: "Workspace not found." });
        return;
      }
      const conv = conversationStoreFor(wsId).create(wsId, name);
      getOrCreateContext(wsId, conv.id);
      sendJson(res, 200, conv);
      return;
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/interaction-mode")) {
      const parts = url.pathname.split("/");
      const convId = parts[3];
      if (!convId) { sendJson(res, 400, { ok: false, message: "Missing conversation id." }); return; }
      const target = resolveTarget(url);
      if (!target || target.conversationId !== convId) {
        sendJson(res, 409, { ok: false, message: "workspaceId and conversationId are required." });
        return;
      }
      const input = (await readJson(req)) as { mode?: unknown; runtime?: unknown };
      if (!isInteractionMode(input.mode)) {
        sendJson(res, 400, { ok: false, message: "A valid interaction mode (direct | collaborative | supervised) is required." });
        return;
      }
      const mode = input.mode;
      const ctx = contextForTarget(target);
      if (!ctx) { sendJson(res, 409, { ok: false, message: "No active conversation context." }); return; }
      try {
        const current = conversationStoreFor(target.workspaceId).get(target.workspaceId, convId);
        if (!current) throw new Error("Conversation not found.");
        // runtime 参数仅用于兼容旧调用方；内部统一以 supervisorConfig 为准。
        const runtime = typeof input.runtime === "string"
          ? input.runtime as import("../shared/types.ts").AgentRuntimeKind
          : current.supervisorConfig?.runtime;
        if (mode === "supervised" && (!runtime || !runtimeAvailable(runtimeKindToCliKey(runtime)))) {
          sendJson(res, 409, { ok: false, message: "Choose an available runtime before enabling supervised collaboration." });
          return;
        }
        // setInteractionMode 通过 onConversationPatch 持久化模式与监工配置
        ctx.setInteractionMode(mode, runtime);
        const updated = conversationStoreFor(target.workspaceId).get(target.workspaceId, convId) ?? current;
        sendJson(res, 200, { ok: true, conversation: updated });
      } catch (error) {
        sendJson(res, 409, { ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    // 监工配置（issue #153）：显式页面上下文，可在任意协作模式下修改，
    // 不依赖全局 active 指针。
    if (req.method === "PUT" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/supervisor-config")) {
      const parts = url.pathname.split("/");
      const convId = parts[3];
      if (!convId) { sendJson(res, 400, { ok: false, message: "Missing conversation id." }); return; }
      const target = resolveTarget(url);
      if (!target || target.conversationId !== convId) {
        sendJson(res, 409, { ok: false, message: "workspaceId and conversationId are required." });
        return;
      }
      const input = (await readJson(req)) as { runtime?: unknown; model?: unknown };
      const parsed = parseSupervisorConfig(input);
      if ("error" in parsed) {
        sendJson(res, 400, { ok: false, message: parsed.error });
        return;
      }
      if (!runtimeAvailable(runtimeKindToCliKey(parsed.config.runtime))) {
        sendJson(res, 409, { ok: false, message: "所选运行时当前不可用，请先安装或换一个运行时。" });
        return;
      }
      const ctx = contextForTarget(target);
      if (!ctx) { sendJson(res, 409, { ok: false, message: "No active conversation context." }); return; }
      try {
        if (!conversationStoreFor(target.workspaceId).get(target.workspaceId, convId)) {
          throw new Error("Conversation not found.");
        }
        ctx.setSupervisorConfig(parsed.config);
        const updated = conversationStoreFor(target.workspaceId).get(target.workspaceId, convId);
        sendJson(res, 200, { ok: true, conversation: updated ? toActiveConversation(updated) : undefined });
      } catch (error) {
        sendJson(res, 409, { ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/conversations/")) {
      const parts = url.pathname.split("/");
      const convId = parts[3];
      if (!convId) { sendJson(res, 400, { ok: false, message: "Missing conversation id." }); return; }
      const wsId = url.searchParams.get("workspaceId") || activeWorkspaceId;
      if (!wsId) { sendJson(res, 409, { ok: false, message: "No active workspace." }); return; }
      const input = (await readJson(req)) as { name?: unknown };
      const name = typeof input.name === "string" ? input.name.trim() : undefined;
      try {
        const store = conversationStoreFor(wsId);
        const conv = store.update(wsId, convId, { name });
        if (convId === activeConversationId && wsId === activeWorkspaceId) {
          activeConversation = toActiveConversation(conv);
        }
        sendJson(res, 200, conv);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sendJson(res, 404, { ok: false, message: msg });
      }
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/conversations/")) {
      const parts = url.pathname.split("/");
      const convId = parts[3];
      if (!convId) { sendJson(res, 400, { ok: false, message: "Missing conversation id." }); return; }
      const wsId = url.searchParams.get("workspaceId") || activeWorkspaceId;
      if (!wsId) {
        sendJson(res, 409, { ok: false, message: "No active workspace." });
        return;
      }
      const targetCtx = contextMap.get(contextKey(wsId, convId));
      if (targetCtx?.hasRunningOrQueued()) {
        sendJson(res, 409, { ok: false, message: "Cannot delete a conversation with running agents." });
        return;
      }
      try {
        const wasActiveConversation = wsId === activeWorkspaceId && convId === activeConversationId;
        disposeContext(wsId, convId);
        const store = conversationStoreFor(wsId);
        store.delete(wsId, convId);
        if (wasActiveConversation) {
          const nextConversation = conversationStore.list(activeWorkspaceId)[0];
          if (nextConversation) {
            activateConversation(nextConversation);
          } else {
            clearActiveConversation();
          }
        }
        sendJson(res, 200, { ok: true });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sendJson(res, 404, { ok: false, message: msg });
      }
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/switch")) {
      const parts = url.pathname.split("/");
      const convId = parts[3];
      if (!convId) { sendJson(res, 400, { ok: false, message: "Missing conversation id." }); return; }
      try {
        const wsId = url.searchParams.get("workspaceId") || activeWorkspaceId;
        const conversation = wsId ? conversationStoreFor(wsId).get(wsId, convId) : null;
        const workspace = wsId ? workspaceStore.get(wsId) : null;
        if (!wsId || !conversation || !workspace) throw new Error("Conversation not found.");
        getOrCreateContext(wsId, convId);
        sendJson(res, 200, { ok: true, workspace: { id: workspace.id, name: workspace.name, path: workspace.path }, conversation: toActiveConversation(conversation) });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sendJson(res, 409, { ok: false, message: msg });
      }
      return;
    }

    // Static files
    if (req.method === "GET" && serveStatic(url.pathname, res)) {
      return;
    }

    sendJson(res, 404, { ok: false, message: "Not found." });
  } catch (error) {
    // 请求体超限返回 413：客户端原本只能看到连接被掐断（fetch failed）。
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, { ok: false, message: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { ok: false, message });
  }
});

// Probe runtimes before accepting connections to avoid startup race
(async () => {
  await probeRuntimes().catch((err) => {
    console.warn("[orbit] runtime probe failed:", err instanceof Error ? err.message : String(err));
  });
  await startServerWithRecovery();
  startPeriodicProbe();
})();

async function startServerWithRecovery(): Promise<void> {
  try {
    await listenOnce(activePort);
    logStarted();
  } catch (error) {
    if (!isAddressInUseError(error)) {
      throw error;
    }
    const recovered = await recoverOccupiedPort();
    if (recovered) {
      await wait(START_RETRY_DELAY_MS);
      await retryRequestedPort();
      return;
    }
    if (await tryFallbackPorts()) return;
    printPortInUseHelp();
    process.exit(1);
  }
}

async function retryRequestedPort(): Promise<void> {
  try {
    await listenOnce(activePort);
    logStarted();
  } catch (retryError) {
    if (isAddressInUseError(retryError) && await tryFallbackPorts()) {
      return;
    }
    if (isAddressInUseError(retryError)) {
      printPortInUseHelp();
      process.exit(1);
    }
    throw retryError;
  }
}

async function tryFallbackPorts(): Promise<boolean> {
  if (process.env.ORBIT_PORT) {
    return false;
  }
  for (let nextPort = requestedPort + 1; nextPort <= requestedPort + AUTO_PORT_RETRY_LIMIT; nextPort++) {
    try {
      activePort = nextPort;
      await listenOnce(activePort);
      console.warn(`[orbit] 端口 ${requestedPort} 已被占用，已自动改用端口 ${activePort}。`);
      logStarted();
      return true;
    } catch (error) {
      if (!isAddressInUseError(error)) {
        throw error;
      }
    }
  }
  activePort = requestedPort;
  return false;
}

function listenOnce(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });
}

async function recoverOccupiedPort(): Promise<boolean> {
  const owners = await findPortOwners(activePort);
  const orbitOwners = owners.filter((owner) => owner.pid !== process.pid && isOrbitPortOwner(owner));
  if (orbitOwners.length === 0) {
    return false;
  }

  for (const owner of orbitOwners) {
    try {
      console.warn(`[orbit] 检测到上一次 Orbit 进程仍占用端口 ${activePort}，正在自动关闭旧进程（PID ${owner.pid}）...`);
      await stopPortOwner(owner);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[orbit] 自动关闭旧 Orbit 进程失败（PID ${owner.pid}）：${message}`);
      return false;
    }
  }
  return true;
}

function isAddressInUseError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

function printPortInUseHelp(): void {
  console.error(`[orbit] 启动失败：端口 ${requestedPort} 到 ${requestedPort + AUTO_PORT_RETRY_LIMIT} 都已被占用。`);
  console.error("[orbit] 请先关闭正在运行的 Orbit 窗口或占用该端口的程序，然后重新执行 orbit。");
  console.error(`[orbit] 如果你需要临时换一个端口，可以执行：set ORBIT_PORT=4318 && orbit`);
}

function logStarted(): void {
  console.log(`[orbit] Orbit 已启动。请在浏览器中打开：http://localhost:${activePort}`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Helpers ---

async function handlePostMessage(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  // 请求入口一次性快照 active 指针（PR #147 M1）：目标优先取 query 参数
  // （#155 页面上下文契约，读取请求体前即固定），旧调用回退入口快照，
  // 读取请求体、提交附件或任何后续 await 期间切换会话都不会改变本条
  // 消息按入口时刻会话的归属。
  const entryActiveWorkspaceId = activeWorkspaceId;
  const entryActiveConversationId = activeConversationId;
  const input = (await readJson(req)) as {
    content?: unknown;
    draftAttachments?: unknown;
    approvalMode?: unknown;
    clientMessageId?: unknown;
    delivery?: unknown;
  };
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const approvalMode: ApprovalMode = input.approvalMode === "full-access" ? "full-access" : "ask";

  const draftAttachments = Array.isArray(input.draftAttachments)
    ? input.draftAttachments as Array<{ id: string; mimeType: string; filename: string; size: number }>
    : [];

  if (!canSendMessage(content, draftAttachments.length)) {
    sendJson(res, 400, { ok: false, message: "Message cannot be empty." });
    return;
  }

  // 原生斜杠命令投递标记（issue #160）：携带 delivery 的请求把命令文本原样
  // 发给指定员工，跳过指派路由；格式非法时整条消息拒绝，避免误当成普通消息。
  const parsedDelivery = parseNativeCommandDelivery(input.delivery);
  if (!parsedDelivery.ok) {
    sendJson(res, 400, { ok: false, message: parsedDelivery.message });
    return;
  }
  const delivery = parsedDelivery.delivery;
  // 原生命令绕过指派直达 runtime 的 prompt 通道，没有承载附件的路径；
  // 带附件时拒绝而不是丢弃附件，避免用户以为附件已随命令送达。
  if (delivery && draftAttachments.length > 0) {
    sendJson(res, 400, { ok: false, message: "原生命令消息不支持附件，请先移除附件再发送命令。" });
    return;
  }

  const workspaceParam = url.searchParams.get("workspaceId");
  const workspaceId = workspaceParam === null ? entryActiveWorkspaceId : workspaceParam.trim();
  const conversationParam = url.searchParams.get("conversationId");
  const requestedConversationId = conversationParam === null ? "" : conversationParam.trim();
  if (!workspaceId || !workspaceStore.get(workspaceId)) {
    sendJson(res, 409, { ok: false, message: "Create or select a workspace before sending a message." });
    return;
  }

  let conversation = requestedConversationId
    ? conversationStoreFor(workspaceId).get(workspaceId, requestedConversationId)
    : null;
  if (requestedConversationId && !conversation) {
    sendJson(res, 404, { ok: false, message: "Conversation not found." });
    return;
  }
  let context = conversation ? getOrCreateContext(workspaceId, conversation.id) : null;

  if (!context) {
    // 无目标会话：合法的首条消息场景，仅在目标工作区内新建（PR #147 M1）。
    conversation = conversationStoreFor(workspaceId).create(workspaceId, conversationTitle(content));
    conversationStoreFor(workspaceId).touchLastOpened(workspaceId, conversation.id);
    context = getOrCreateContext(workspaceId, conversation.id);
    // Compare-and-set（PR #147 M1）：仅当实时 active 指针仍等于入口快照
    // （读取请求体期间用户未切换）且新会话建在入口工作区时才写回，
    // 否则不打断用户已切换到的会话。判定与写回之间无 await 穿插。
    const legacyRequest = workspaceParam === null;
    if (legacyRequest
      && workspaceId === entryActiveWorkspaceId
      && activeWorkspaceId === entryActiveWorkspaceId
      && activeConversationId === entryActiveConversationId) {
      activeConversationId = conversation.id;
      activeConversation = toActiveConversation(conversation);
      saveLastActive(workspaceId, conversation.id);
    }
  } else if (conversation?.name === UNTITLED_CONVERSATION_NAME) {
    conversation = conversationStoreFor(workspaceId).update(workspaceId, conversation.id, { name: conversationTitle(content) });
    if (workspaceId === activeWorkspaceId && conversation.id === activeConversationId) activeConversation = toActiveConversation(conversation);
  }

  if (!context || !conversation) {
    sendJson(res, 500, { ok: false, message: "Conversation context was not initialized." });
    return;
  }

  // 原生斜杠命令的语义校验（issue #160）：目标必须是当前会话已启用的普通
  // 员工，且命令名在该员工 runtime 会话通告的列表中。
  if (delivery) {
    const profile = context.agents.profile(delivery.agentId);
    if (!profile || profile.internal) {
      sendJson(res, 400, { ok: false, message: "目标数字员工不存在或未启用。" });
      return;
    }
    const commands = context.availableCommands()[delivery.agentId] ?? [];
    const commandName = nativeCommandName(delivery.prompt);
    if (!commandName || !commands.some((command) => command.name === commandName)) {
      sendJson(res, 400, { ok: false, message: "该数字员工当前未通告此命令，命令未发送。" });
      return;
    }
  }

  const clientMessageId = typeof input.clientMessageId === "string" ? input.clientMessageId.trim() : "";
  await context.withMessageMutation(async () => {
    if (clientMessageId) {
      const existing = context.messages.findByClientMessageId(clientMessageId);
      if (existing) {
        sendJson(res, 200, { ok: true, messageId: existing.id, workspaceId, conversationId: conversation!.id, deduplicated: true });
        return;
      }
    }
    // Commit draft attachments if present
    let attachments: import("../shared/types.ts").MessageAttachment[] | undefined;
    if (draftAttachments.length > 0) {
      // Enforce max files per message
      if (draftAttachments.length > ATTACHMENT_LIMITS.MAX_FILES_PER_MESSAGE) {
        sendJson(res, 400, {
          ok: false,
          message: `附件数量过多（${draftAttachments.length} 个），每条消息最多 ${ATTACHMENT_LIMITS.MAX_FILES_PER_MESSAGE} 个。`,
        });
        return;
      }
      try {
        attachments = await attachmentStore.commitDrafts({
          workspaceId,
          conversationId: conversation!.id,
          draftAttachments,
        });
      } catch (error) {
        // 草稿缺失/过期/校验失败：整条消息不发送，保留可恢复状态。
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { ok: false, message });
        return;
      }
    }

    // 模式快照：每条用户消息在发送时记录当轮 interaction mode，
    // 后续员工运行、转交、监工检查都继承该值，不读取执行时的全局模式。
    const userMessage = context.messages.add({
      kind: "user",
      ...(clientMessageId ? { clientMessageId } : {}),
      content,
      status: "sent",
      attachments,
      approvalMode,
      interactionMode: conversation!.interactionMode ?? "direct",
    });
    eventBus.publish({ type: "message.created", workspaceId, conversationId: conversation!.id, message: userMessage });
    // 原生斜杠命令（issue #160）：绕过指派路由直通员工；普通消息维持路由。
    if (delivery) {
      context.runManager.enqueueNativeCommand(delivery.agentId, delivery.prompt, userMessage);
    } else {
      context.messageRouter.process(userMessage);
    }

    sendJson(res, 200, { ok: true, messageId: userMessage.id, workspaceId, conversationId: conversation!.id });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNativeCommandDelivery(
  input: unknown,
): { ok: true; delivery: NativeCommandDelivery | null } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, delivery: null };
  if (!isRecord(input) || input.type !== "acp_command") {
    return { ok: false, message: "delivery 格式不正确。" };
  }
  if (typeof input.agentId !== "string" || !input.agentId.trim()) {
    return { ok: false, message: "delivery.agentId 不能为空。" };
  }
  if (typeof input.prompt !== "string" || !input.prompt.trim().startsWith("/")) {
    return { ok: false, message: "delivery.prompt 必须是以 / 开头的命令文本。" };
  }
  return {
    ok: true,
    delivery: { type: "acp_command", agentId: input.agentId.trim(), prompt: input.prompt.trim() },
  };
}

/** 从命令文本提取命令名（去掉前导 "/" 与参数），如 "/init src" → "init"。 */
function nativeCommandName(content: string): string | null {
  const firstToken = content.trim().split(/\s+/)[0] ?? "";
  if (!firstToken.startsWith("/")) return null;
  const name = firstToken.slice(1);
  return name || null;
}

function parseElicitationResponse(input: unknown): ElicitationResponse | null {
  if (!isRecord(input) || typeof input.action !== "string") return null;
  if (input.action === "decline") return { action: "decline" };
  if (input.action === "cancel") return { action: "cancel" };
  if (input.action !== "accept") return null;

  if (input.content === undefined) return { action: "accept" };
  if (!isRecord(input.content)) return null;

  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(input.content)) {
    if (typeof value === "string" || typeof value === "boolean") {
      content[key] = value;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      content[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      content[key] = value;
      continue;
    }
    return null;
  }
  return { action: "accept", content };
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function emptyMessageHistory() {
  return { hasOlderMessages: false, olderCursor: null };
}

function emptyMessagePage(): MessagePage {
  return { messages: [], hasOlderMessages: false, olderCursor: null };
}

function runHistoryCleanup(): void {
  try {
    const result = cleanupHistory({
      activeConversations: activeWorkspaceId && activeConversationId
        ? [{ workspaceId: activeWorkspaceId, conversationId: activeConversationId }]
        : [],
    });
    // 附件随分片回收而删除，静默发生时无从诊断，故清理有结果就记一行。
    if (result.deletedMessageShards > 0 || result.deletedTranscriptSegments > 0 || result.deletedAttachments > 0) {
      console.log(
        `[orbit] history cleanup removed ${result.deletedMessageShards} message shard(s), `
        + `${result.deletedTranscriptSegments} transcript segment(s) and `
        + `${result.deletedAttachments} orphaned attachment(s)`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[orbit] history cleanup skipped: ${message}`);
  }
}

function runAttachmentDraftCleanup(): void {
  attachmentStore.cleanupExpiredDrafts().then((count) => {
    if (count > 0) {
      console.log(`[orbit] cleaned up ${count} expired attachment draft(s)`);
    }
  }).catch((err) => {
    console.warn("[orbit] attachment draft cleanup failed:", err instanceof Error ? err.message : String(err));
  });

  // Periodic cleanup every hour
  const interval = setInterval(() => {
    attachmentStore.cleanupExpiredDrafts().catch(() => { /* best effort */ });
  }, 60 * 60 * 1000);
  if (typeof interval === "object" && "unref" in interval) {
    (interval as NodeJS.Timeout).unref();
  }
}

function conversationTitle(content: string): string {
  const title = content.replace(/\s+/g, " ").trim();
  if (!title) {
    return UNTITLED_CONVERSATION_NAME;
  }
  return title.length > 24 ? `${title.slice(0, 24)}...` : title;
}

async function pickWindowsDirectory(): Promise<string> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.StartPosition = 'CenterScreen'",
    "$owner.Width = 1",
    "$owner.Height = 1",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Select workspace folder'",
    "$dialog.ShowNewFolderButton = $true",
    "$owner.Add_Shown({ $owner.Activate() })",
    "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  Write-Output $dialog.SelectedPath",
    "}",
    "$owner.Dispose()",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
    windowsHide: false,
  });
  return stdout.trim();
}

async function pickMacDirectory(): Promise<string> {
  const { stdout } = await execFileAsync("osascript", [
    "-e",
    'POSIX path of (choose folder with prompt "Select workspace folder")',
  ]);
  return stdout.trim();
}

async function pickDirectory(): Promise<string> {
  switch (process.platform) {
    case "win32":
      return pickWindowsDirectory();
    case "darwin":
      return pickMacDirectory();
    default:
      throw new Error(`Directory picker is not supported on ${process.platform}.`);
  }
}

async function handlePutAgents(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const workspaceId = url.searchParams.get("workspaceId") || activeWorkspaceId;
  if (!workspaceId || !workspaceStore.get(workspaceId)) {
    sendJson(res, 409, { ok: false, message: "Create or select a workspace before saving agents." });
    return;
  }
  if ([...contextMap].some(([key, ctx]) => key.startsWith(`${workspaceId}:`) && ctx.hasRunningOrQueued())) {
    sendJson(res, 409, { ok: false, message: "Cannot save while an agent is running. Wait for it to finish." });
    return;
  }

  const input = (await readJson(req)) as AgentConfigWithModelState[];
  if (!Array.isArray(input)) {
    sendJson(res, 400, { ok: false, message: "Request body must be an array of agent configs." });
    return;
  }

  const errors = validateAgentConfigs(input);
  if (errors.length > 0) {
    sendJson(res, 400, { ok: false, message: errors.join(" ") });
    return;
  }

  // modelState 是 GET 响应合并的运行时快照，保存前剥离，避免污染 agents.json。
  const configs = input.map(({ modelState: _modelState, modelProbe: _modelProbe, ...config }) => config);
  configStore.save(workspaceId, configs);
  refreshEnabledAgentsForWorkspace(workspaceId, configs);
  if (workspaceId === activeWorkspaceId) allConfigs = configs;
  sendJson(res, 200, configsWithModelState(workspaceId));
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopPeriodicProbe();
  sseHub.closeAll();
  for (const ctx of contextMap.values()) {
    ctx.dispose();
  }
  contextMap.clear();
  contextLru.length = 0;
  disposeAcpConnectionPool();
  const forceExitTimer = setTimeout(() => {
    process.exit(0);
  }, SHUTDOWN_FORCE_EXIT_MS);
  if (typeof forceExitTimer === "object" && "unref" in forceExitTimer) {
    forceExitTimer.unref();
  }
  server.closeAllConnections?.();
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
