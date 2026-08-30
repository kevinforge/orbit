import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { configsToProfiles } from "../core/agent-profiles.ts";
import { disposeAcpConnectionPool, probeAcpModelState } from "../core/acp-runtime.ts";
import { defaultAcpRunnerRegistry } from "../core/acp-runner-registry.ts";
import { AGENT_TEAM_TEMPLATES, AgentConfigStore, validateAgentConfigs } from "../core/agent-config-store.ts";
import { AgentModelStateStore } from "../core/agent-model-state-store.ts";
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
import type { AgentConfigWithModelState, AgentModelProbeResponse, AgentModelProbeState, ApprovalMode, Conversation, ConversationInfo, ElicitationResponse, InteractionMode, MessagePage, PermissionDecision, RunningSummary, WorkspaceInfo } from "../shared/types.ts";
import { isInteractionMode } from "../shared/types.ts";
import { ATTACHMENT_LIMITS } from "../shared/types.ts";
import { AttachmentStore } from "../core/attachment-store.ts";
import { buildAttachmentHeaders } from "./attachment-response.ts";
import { resolveMessageTarget, shouldPromoteNewConversation } from "./message-target.ts";
import { ConversationContext } from "./conversation-context.ts";
import { findPortOwners, isOrbitPortOwner, stopPortOwner } from "./port-recovery.ts";
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
  supervisionRuntime?: ConversationInfo["supervisionRuntime"];
}): ConversationInfo {
  return {
    id: conversation.id,
    name: conversation.name,
    interactionMode: conversation.interactionMode ?? "direct",
    lastDirectAgentId: conversation.lastDirectAgentId,
    supervisionRuntime: conversation.supervisionRuntime,
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
): Promise<void> {
  if (!activeWorkspaceId) return;
  const workspaceId = activeWorkspaceId;
  const workspace = workspaceStore.get(workspaceId);
  if (!workspace) return;

  const existing = agentModelStateStore.load(workspaceId);
  const targetsByRuntime = new Map<AgentConfig["runtime"], Array<Pick<AgentConfig, "id" | "runtime">>>();
  if (runtimeFilter && targetAgentId) {
    targetsByRuntime.set(runtimeFilter, [{ id: targetAgentId, runtime: runtimeFilter }]);
  } else {
    for (const config of allConfigs) {
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
        const previous = existing[target.id];
        const hasSessionValue = previous?.runtimeKind === runtimeKind && previous.currentValueSource === "session";
        const targetSnapshot = {
          ...snapshot,
          agentId: target.id,
          currentValue: hasSessionValue ? previous.currentValue : undefined,
          currentValueSource: hasSessionValue ? "session" as const : "probe" as const,
        };
        agentModelStateStore.update(workspaceId, targetSnapshot);
        sseHub.publish({
          type: "agent.model_state",
          workspaceId,
          agentId: target.id,
          modelState: targetSnapshot,
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
  return allConfigs.map((config) => ({
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

// Forward all events to SSE clients (single global subscriber)
eventBus.subscribe((event) => {
  if (event.type === "runtime.activity") return;
  sseHub.publish(event);
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
      if (ctx && !ctx.hasRunningAgent()) {
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
  const configs = workspaceId === activeWorkspaceId
    ? allConfigs
    : configStore.load(workspaceId);
  const enabledConfigs = configs.filter((c) => c.enabled);
  const ws = workspaceStore.get(workspaceId);
  const profiles = configsToProfiles(enabledConfigs, ws!.path);
  const sessStore = new SessionStore(workspaceStore.sessionsDir(workspaceId));
  const workspaceConfig = workspaceConfigStore.load(workspaceId);
  const conversation = conversationStore.get(workspaceId, conversationId);
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
    supervisionRuntime: conversation?.supervisionRuntime,
    lastDirectAgentId: conversation?.lastDirectAgentId,
    // 模型快照桥（issue #142）：runtime 返回的模型列表/当前值写穿到 workspace
    // 级存储，同时广播给 UI；读取供池复用捷径补发偏好。
    modelState: {
      load: (agentId) => agentModelStateStore.get(workspaceId, agentId),
      update: (snapshot) => {
        agentModelStateStore.update(workspaceId, snapshot);
        sseHub.publish({ type: "agent.model_state", workspaceId, agentId: snapshot.agentId, modelState: snapshot });
      },
    },
    onConversationPatch: (patch) => {
      try {
        const store = workspaceId === activeWorkspaceId ? conversationStore : new ConversationStore();
        const updated = store.update(workspaceId, conversationId, patch);
        if (workspaceId === activeWorkspaceId && conversationId === activeConversationId) {
          activeConversation = toActiveConversation(updated);
          publishContextSwitched();
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

  publishContextSwitched();
}

function switchConversation(conversationId: string): void {
  if (conversationId === activeConversationId) return;
  if (!activeWorkspaceId) throw new Error("No active workspace.");
  // No running-agent check

  const conv = conversationStore.get(activeWorkspaceId, conversationId);
  if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

  // Issue #77: Don't touch lastOpenedAt when switching conversations
  activateConversation(conv, false);
  publishContextSwitched();
}

function refreshEnabledAgents(): void {
  if (!activeWorkspaceId) return;
  const enabledConfigs = allConfigs.filter((c) => c.enabled);
  const profiles = configsToProfiles(enabledConfigs, activeWorkspace.path);

  // Refresh profiles for ALL contexts in the same workspace, not just the active one
  for (const [key, ctx] of contextMap) {
    if (key.startsWith(`${activeWorkspaceId}:`)) {
      ctx.refreshProfiles(profiles);
    }
  }
}

function publishContextSwitched(): void {
  sseHub.publish({
    type: "context.switched",
    workspace: activeWorkspace,
    conversation: activeConversation,
  });
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
  publishContextSwitched();
}

function clearActiveConversation(): void {
  // Don't dispose — just clear the active pointer
  activeConversationId = "";
  activeConversation = EMPTY_CONVERSATION;
  saveLastActive(activeWorkspaceId, activeConversationId);
  publishContextSwitched();
}

/**
 * 附件下载名：优先使用会话消息历史里记录的用户原始文件名；存储文件名是
 * `<id>.<ext>`，直接下发会让"用户说明.txt"下载成 UUID 名。
 */
function resolveAttachmentFilename(workspaceId: string, conversationId: string, attachmentId: string): string | null {
  const ctx = contextMap.get(contextKey(workspaceId, conversationId));
  if (ctx) {
    return ctx.messages.attachmentFilename(attachmentId);
  }
  // 该会话当前没有活动上下文：只读打开消息历史，不做任何写入。
  const messages = new MessageStore(
    path.join(workspaceStore.channelsDir(workspaceId, conversationId), "messages.json"),
    { historyRead: true },
  );
  return messages.attachmentFilename(attachmentId);
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

// --- HTTP Server (created before probe to avoid blocking setup) ---
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // SSE
    if (req.method === "GET" && url.pathname === "/events") {
      sseHub.add(res);
      return;
    }

    // State
    if (req.method === "GET" && url.pathname === "/api/state") {
      const ctx = getActiveContext();
      const messages = ctx?.messages.list() ?? [];
      sendJson(res, 200, {
        workspace: activeWorkspace,
        conversation: activeConversation,
        agents: currentAgentStates(),
        messages: ctx?.runManager.projectLiveProcessState(messages) ?? messages,
        messageHistory: ctx?.messages.historyState() ?? emptyMessageHistory(),
        terminal: ctx?.transcripts.all() ?? {},
        runningSummaries: buildRunningSummaries(),
        runtimeAvailability: getRuntimeAvailabilityArray(),
        pendingPermissions: ctx?.pendingPermissions() ?? [],
        pendingElicitations: ctx?.pendingElicitations() ?? [],
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/work-analysis") {
      if (!activeWorkspaceId) {
        sendJson(res, 409, { ok: false, message: "Create or select a workspace before viewing work analysis." });
        return;
      }
      const requestedDays = Number(url.searchParams.get("days") ?? 30);
      const days = Number.isFinite(requestedDays) ? Math.max(1, Math.min(365, Math.floor(requestedDays))) : 30;
      sendJson(res, 200, buildWorkspaceWorkAnalysis({
        workspaceId: activeWorkspaceId,
        days,
        workspaceStore,
        conversationStore,
        agentConfigStore: configStore,
      }));
      return;
    }

    // Messages
    if (req.method === "GET" && url.pathname === "/api/messages") {
      const ctx = getActiveContext();
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
      await handlePostMessage(req, res);
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
      const ctx = getActiveContext();
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
      const ctx = getActiveContext();
      if (!ctx?.resolveElicitation(requestId, response)) {
        sendJson(res, 404, { ok: false, message: "Elicitation request is no longer pending." });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // Interrupt current auto-collaboration chain
    if (req.method === "POST" && url.pathname === "/api/conversation/interrupt") {
      const ctx = getActiveContext();
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
      const input = (await readJson(req)) as {
        workspaceId?: unknown;
        conversationId?: unknown;
        data?: unknown;
        mimeType?: unknown;
        filename?: unknown;
      };
      // 目标来自请求快照而非全局 active 指针：上传进行中切换会话时，
      // 文件仍保存到发起上传的会话目录，不会错投到新会话（PR #147 M1）。
      const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : "";
      const conversationId = typeof input.conversationId === "string" ? input.conversationId : "";
      const base64Data = typeof input.data === "string" ? input.data : "";
      const mimeType = typeof input.mimeType === "string" ? input.mimeType : "";
      const filename = typeof input.filename === "string" ? input.filename : "";

      if (!workspaceId || !conversationId) {
        sendJson(res, 409, { ok: false, message: "No active conversation." });
        return;
      }
      if (!workspaceStore.get(workspaceId) || !conversationStore.get(workspaceId, conversationId)) {
        sendJson(res, 404, { ok: false, message: "Workspace or conversation not found." });
        return;
      }
      if (!base64Data) {
        sendJson(res, 400, { ok: false, message: "Missing attachment data." });
        return;
      }

      const buffer = Buffer.from(base64Data, "base64");
      const validation = AttachmentStore.validateUpload(buffer, mimeType, filename);
      if (!validation.valid) {
        sendJson(res, 400, { ok: false, message: validation.error });
        return;
      }
      const validated = validation.attachment;

      // Issue #88: Check draft count limit before saving
      const draftCount = await attachmentStore.countDrafts(workspaceId, conversationId);
      if (draftCount >= ATTACHMENT_LIMITS.MAX_DRAFTS_PER_CONVERSATION) {
        sendJson(res, 400, {
          ok: false,
          message: `Too many pending attachments (limit ${ATTACHMENT_LIMITS.MAX_DRAFTS_PER_CONVERSATION}). Please send or remove the existing attachments first.`
        });
        return;
      }

      const saved = await attachmentStore.saveDraft({
        workspaceId,
        conversationId,
        data: buffer,
        ext: validated.ext,
        filename: validated.filename,
      });

      sendJson(res, 200, {
        ok: true,
        attachment: {
          id: saved.id,
          kind: validated.kind,
          mimeType: validated.mimeType,
          filename: validated.filename,
          size: saved.size,
          ...(validated.kind === "image"
            ? { previewUrl: `/api/attachments/drafts/${workspaceId}/${conversationId}/${saved.id}` }
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
      const displayFilename = resolveAttachmentFilename(wsId, convId, attachId) ?? attachment.filename;
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

      // Search all active contexts for the run
      let result: { ok: boolean; reason?: string } = { ok: false, reason: "not_found" };
      for (const [, ctx] of contextMap) {
        const candidate = ctx.runManager.cancel(runId);
        if (candidate.ok) {
          result = candidate;
          break;
        }
        // Any reason other than "not_found" is definitive — stop searching
        if (candidate.reason !== "not_found") {
          result = candidate;
          break;
        }
      }

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
      sendJson(res, 200, activeWorkspaceId ? configsWithModelState(activeWorkspaceId) : allConfigs);
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
      await probeConfiguredAgentModels(
        url.searchParams.get("force") === "1",
        runtimeFilter ?? undefined,
        targetAgentId,
      );
      const configs = activeWorkspaceId ? configsWithModelState(activeWorkspaceId) : allConfigs;
      const response: AgentModelProbeResponse = { configs };
      if (activeWorkspaceId && runtimeFilter && targetAgentId) {
        const snapshot = agentModelStateStore.get(activeWorkspaceId, targetAgentId);
        const matchingSnapshot = snapshot?.runtimeKind === runtimeFilter ? snapshot : undefined;
        response.target = {
          agentId: targetAgentId,
          runtimeKind: runtimeFilter,
          modelState: matchingSnapshot ?? null,
          modelProbe: modelProbeStateFor(activeWorkspaceId, runtimeFilter, matchingSnapshot),
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
      await handlePutAgents(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agents/reset") {
      if (!activeWorkspaceId) {
        sendJson(res, 409, { ok: false, message: "Create or select a workspace before resetting agents." });
        return;
      }
      const ctx = getActiveContext();
      if (ctx?.hasRunningAgent()) {
        sendJson(res, 409, { ok: false, message: "Cannot reset while an agent is running. Wait for it to finish." });
        return;
      }
      allConfigs = configStore.reset(activeWorkspaceId);
      refreshEnabledAgents();
      sendJson(res, 200, allConfigs);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agents/apply-team") {
      if (!activeWorkspaceId) {
        sendJson(res, 409, { ok: false, message: "Create or select a workspace before applying a team." });
        return;
      }
      const ctx = getActiveContext();
      if (ctx?.hasRunningAgent()) {
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
      allConfigs = initialAgentConfigsForWorkspacePreset(template.id, getRuntimeAvailabilityArray()) ?? [];
      configStore.save(activeWorkspaceId, allConfigs);
      refreshEnabledAgents();
      sendJson(res, 200, allConfigs);
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
      if (!activeWorkspaceId) {
        sendJson(res, 200, { systemPrompt: "", rules: [] });
        return;
      }
      sendJson(res, 200, workspaceConfigStore.load(activeWorkspaceId));
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/workspace-config") {
      if (!activeWorkspaceId) {
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
      workspaceConfigStore.save(activeWorkspaceId, input);
      const resolved = workspaceConfigStore.load(activeWorkspaceId);
      // Update all active contexts for this workspace so the next agent run
      // immediately uses the new config.
      for (const [key, ctx] of contextMap) {
        if (key.startsWith(`${activeWorkspaceId}:`)) {
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
        if (key.startsWith(`${wsId}:`) && ctx.hasRunningAgent()) {
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
      if (!activeWorkspaceId) {
        sendJson(res, 200, []);
        return;
      }
      sendJson(res, 200, conversationStore.list(activeWorkspaceId));
      return;
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/workspaces\/[^/]+\/conversations$/)) {
      const parts = url.pathname.split("/");
      const wsId = parts[3];
      if (!wsId) { sendJson(res, 400, { ok: false, message: "Missing workspace id." }); return; }
      try {
        const store = wsId === activeWorkspaceId ? conversationStore : new ConversationStore();
        sendJson(res, 200, store.list(wsId));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sendJson(res, 404, { ok: false, message: msg });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/conversations") {
      // 入口快照先于 readJson 取得；创建会话是显式操作，但读取请求体期间
      // 用户可能又切换了会话/工作区，写回 active 前必须 compare-and-set。
      const entryActiveWorkspaceId = activeWorkspaceId;
      const entryActiveConversationId = activeConversationId;
      const wsId = url.searchParams.get("workspaceId") || entryActiveWorkspaceId;
      if (!wsId) {
        sendJson(res, 409, { ok: false, message: "Create or select a workspace before creating a conversation." });
        return;
      }
      const input = (await readJson(req)) as { name?: unknown };
      const name = conversationTitle(typeof input.name === "string" ? input.name : "");
      const conv = conversationStore.create(wsId, name);
      if (shouldPromoteNewConversation(
        { workspaceId: entryActiveWorkspaceId, conversationId: entryActiveConversationId },
        { workspaceId: activeWorkspaceId, conversationId: activeConversationId },
      )) {
        // Switch workspace if creating in a different one
        if (wsId !== activeWorkspaceId) {
          switchWorkspace(wsId);
        }
        activateConversation(conv);
      }
      publishContextSwitched();
      sendJson(res, 200, conv);
      return;
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/interaction-mode")) {
      const parts = url.pathname.split("/");
      const convId = parts[3];
      if (!convId) { sendJson(res, 400, { ok: false, message: "Missing conversation id." }); return; }
      if (convId !== activeConversationId || !activeWorkspaceId) {
        sendJson(res, 409, { ok: false, message: "Only the active conversation can change the interaction mode." });
        return;
      }
      const input = (await readJson(req)) as { mode?: unknown; runtime?: unknown };
      if (!isInteractionMode(input.mode)) {
        sendJson(res, 400, { ok: false, message: "A valid interaction mode (direct | collaborative | supervised) is required." });
        return;
      }
      const mode = input.mode;
      const ctx = getActiveContext();
      if (!ctx) { sendJson(res, 409, { ok: false, message: "No active conversation context." }); return; }
      try {
        const current = conversationStore.get(activeWorkspaceId, activeConversationId);
        if (!current) throw new Error("Conversation not found.");
        const runtime = typeof input.runtime === "string" ? input.runtime as import("../shared/types.ts").AgentRuntimeKind : current.supervisionRuntime;
        if (mode === "supervised" && (!runtime || !runtimeAvailable(runtimeKindToCliKey(runtime)))) {
          sendJson(res, 409, { ok: false, message: "Choose an available runtime before enabling supervised collaboration." });
          return;
        }
        // setInteractionMode 通过 onConversationPatch 持久化并广播 context.switched
        ctx.setInteractionMode(mode, runtime);
        const updated = conversationStore.get(activeWorkspaceId, activeConversationId) ?? current;
        activeConversation = toActiveConversation(updated);
        sendJson(res, 200, { ok: true, conversation: updated });
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
        const store = wsId === activeWorkspaceId ? conversationStore : new ConversationStore();
        const conv = store.update(wsId, convId, { name });
        if (convId === activeConversationId && wsId === activeWorkspaceId) {
          activeConversation = toActiveConversation(conv);
          publishContextSwitched();
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
      if (targetCtx?.hasRunningAgent()) {
        sendJson(res, 409, { ok: false, message: "Cannot delete a conversation with running agents." });
        return;
      }
      try {
        const wasActiveConversation = wsId === activeWorkspaceId && convId === activeConversationId;
        disposeContext(wsId, convId);
        attachmentStore.deleteConversationAttachments(wsId, convId).catch(() => { /* best effort */ });
        const store = wsId === activeWorkspaceId ? conversationStore : new ConversationStore();
        store.delete(wsId, convId);
        if (wasActiveConversation) {
          const nextConversation = conversationStore.list(activeWorkspaceId)[0];
          if (nextConversation) {
            activateConversation(nextConversation);
            publishContextSwitched();
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
        const wsId = url.searchParams.get("workspaceId");
        if (wsId && wsId !== activeWorkspaceId) {
          switchWorkspace(wsId);
        }
        switchConversation(convId);
        sendJson(res, 200, { ok: true, workspace: activeWorkspace, conversation: activeConversation });
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

async function handlePostMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // 请求入口一次性快照 active 指针：读取请求体、提交附件或任何后续 await
  // 期间切换会话，都不会改变本条消息按入口时刻会话的归属（PR #147 M1）。
  const entryActiveWorkspaceId = activeWorkspaceId;
  const entryActiveConversationId = activeConversationId;
  const input = (await readJson(req)) as {
    content?: unknown;
    workspaceId?: unknown;
    conversationId?: unknown;
    draftAttachments?: unknown;
    approvalMode?: unknown;
  };
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const approvalMode: ApprovalMode = input.approvalMode === "full-access" ? "full-access" : "ask";

  if (!content) {
    sendJson(res, 400, { ok: false, message: "Message cannot be empty." });
    return;
  }

  const target = resolveMessageTarget(
    input,
    { workspaceId: entryActiveWorkspaceId, conversationId: entryActiveConversationId },
    {
      workspace: (workspaceId) => Boolean(workspaceStore.get(workspaceId)),
      conversation: (workspaceId, conversationId) => Boolean(conversationStore.get(workspaceId, conversationId)),
    },
  );
  if (!target.ok) {
    sendJson(res, target.status, { ok: false, message: target.message });
    return;
  }

  let conversation = target.conversationId
    ? conversationStore.get(target.workspaceId, target.conversationId)
    : null;
  let context: ConversationContext | null;

  if (conversation) {
    // 目标会话存在（显式指定或入口快照）：context 被 LRU 回收时恢复，
    // 绝不为已存在的会话新建（PR #147 M1）。
    context = getOrCreateContext(target.workspaceId, conversation.id);
  } else {
    // 无目标会话：合法的首条消息场景，仅在解析出的工作区内新建。
    conversation = conversationStore.create(target.workspaceId, conversationTitle(content));
    conversationStore.touchLastOpened(target.workspaceId, conversation.id);
    context = getOrCreateContext(target.workspaceId, conversation.id);
    // Compare-and-set（PR #147 M1）：仅当实时 active 指针仍等于入口快照
    // （读取请求体期间用户未切换）且新会话建在入口工作区时才写回，
    // 否则不打断用户已切换到的会话。判定与写回之间无 await 穿插。
    if (target.workspaceId === entryActiveWorkspaceId && shouldPromoteNewConversation(
      { workspaceId: entryActiveWorkspaceId, conversationId: entryActiveConversationId },
      { workspaceId: activeWorkspaceId, conversationId: activeConversationId },
    )) {
      activeConversationId = conversation.id;
      activeConversation = toActiveConversation(conversation);
      saveLastActive(target.workspaceId, conversation.id);
    }
    publishContextSwitched();
  }

  // 未命名会话收到首条消息时按内容命名；仅当目标会话即入口快照会话。
  if (conversation.name === UNTITLED_CONVERSATION_NAME && conversation.id === entryActiveConversationId) {
    conversation = conversationStore.update(target.workspaceId, conversation.id, { name: conversationTitle(content) });
    if (conversation.id === activeConversationId) {
      activeConversation = toActiveConversation(conversation);
    }
    publishContextSwitched();
  }

  if (!context || !conversation) {
    sendJson(res, 500, { ok: false, message: "Conversation context was not initialized." });
    return;
  }

  // Commit draft attachments if present
  let attachments: import("../shared/types.ts").MessageAttachment[] | undefined;
  const draftAttachments = Array.isArray(input.draftAttachments)
    ? input.draftAttachments as Array<{ id: string; mimeType: string; filename: string; size: number }>
    : [];

  if (draftAttachments.length > 0) {
    // Enforce max files per message
    if (draftAttachments.length > ATTACHMENT_LIMITS.MAX_FILES_PER_MESSAGE) {
      sendJson(res, 400, {
        ok: false,
        message: `Too many attachments (${draftAttachments.length}). Maximum is ${ATTACHMENT_LIMITS.MAX_FILES_PER_MESSAGE}.`,
      });
      return;
    }
    try {
      attachments = await attachmentStore.commitDrafts({
        workspaceId: target.workspaceId,
        conversationId: conversation.id,
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
    content,
    status: "sent",
    attachments,
    approvalMode,
    interactionMode: conversation?.interactionMode ?? "direct",
  });
  eventBus.publish({ type: "message.created", conversationId: conversation.id, message: userMessage });
  context.messageRouter.process(userMessage);

  sendJson(res, 200, { ok: true, messageId: userMessage.id });
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodySize = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        req.destroy(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
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
    cleanupHistory({
      activeConversations: activeWorkspaceId && activeConversationId
        ? [{ workspaceId: activeWorkspaceId, conversationId: activeConversationId }]
        : [],
    });
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

async function handlePutAgents(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!activeWorkspaceId) {
    sendJson(res, 409, { ok: false, message: "Create or select a workspace before saving agents." });
    return;
  }
  const ctx = getActiveContext();
  if (ctx?.hasRunningAgent()) {
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
  allConfigs = input.map(({ modelState: _modelState, modelProbe: _modelProbe, ...config }) => config);
  configStore.save(activeWorkspaceId, allConfigs);
  refreshEnabledAgents();
  sendJson(res, 200, configsWithModelState(activeWorkspaceId));
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
