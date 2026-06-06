import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { configsToProfiles } from "../core/agent-profiles.ts";
import { AgentConfigStore, validateAgentConfigs } from "../core/agent-config-store.ts";
import { probeAllRuntimes, runtimeKindToCliKey, type RuntimeProbeResult } from "../core/runtime-probe.ts";
import type { AgentConfig } from "../core/agent-config-store.ts";
import { WorkspaceConfigStore } from "../core/workspace-config-store.ts";
import type { WorkspaceConfig } from "../core/workspace-config-store.ts";
import { ConversationStore } from "../core/conversation-store.ts";
import { EventBus } from "../core/event-bus.ts";
import { SessionStore } from "../core/session-store.ts";
import { WorkspaceStore } from "../core/workspace-store.ts";
import { migrateChannelLayer } from "../core/migrate-channel-layer.ts";
import { cleanupHistory } from "../core/history-retention.ts";
import type { ConversationInfo, MessagePage, RunningSummary, WorkspaceInfo } from "../shared/types.ts";
import { ATTACHMENT_LIMITS } from "../shared/types.ts";
import { AttachmentStore } from "../core/attachment-store.ts";
import { ConversationContext } from "./conversation-context.ts";
import { serveStatic } from "./static-server.ts";
import { SseHub } from "./sse-hub.ts";

const port = Number(process.env.ORBIT_PORT ?? 4317);
const UNTITLED_CONVERSATION_NAME = "新会话";
const EMPTY_WORKSPACE: WorkspaceInfo = { id: "", name: "", path: "" };
const EMPTY_CONVERSATION: ConversationInfo = { id: "", name: "" };
const execFileAsync = promisify(execFile);

// --- Shared singletons ---
const eventBus = new EventBus();
const sseHub = new SseHub();
const workspaceStore = new WorkspaceStore();
const configStore = new AgentConfigStore();
const workspaceConfigStore = new WorkspaceConfigStore();
const attachmentStore = new AttachmentStore(path.join(os.homedir(), ".orbit"));

// --- Runtime availability ---
const PROBE_INTERVAL_MS = Number(process.env.ORBIT_RUNTIME_PROBE_INTERVAL_MS ?? 60000);
let runtimeAvailability: Map<string, RuntimeProbeResult> = new Map();
let probeTimer: ReturnType<typeof setInterval> | null = null;

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
  return new ConversationContext({
    workspaceId,
    conversationId,
    profiles,
    eventBus,
    sessionStore: sessStore,
    workspaceStore,
    workspaceConfig,
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

function activateConversation(conversation: { id: string; name: string }): void {
  // No dispose of old context — it stays alive in the map for parallel execution
  activeConversationId = conversation.id;
  activeConversation = { id: conversation.id, name: conversation.name };
  conversationStore.touchLastOpened(activeWorkspaceId, activeConversationId);
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

  activateConversation(conv);
  publishContextSwitched();
}

function refreshEnabledAgents(): void {
  if (!activeWorkspaceId || !activeConversationId) return;
  const ctx = getActiveContext();
  if (!ctx) return;
  const enabledConfigs = allConfigs.filter((c) => c.enabled);
  const profiles = configsToProfiles(enabledConfigs, activeWorkspace.path);
  ctx.refreshProfiles(profiles);
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
      role: config.role,
      triggers: config.triggers,
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
      sendJson(res, 200, {
        workspace: activeWorkspace,
        conversation: activeConversation,
        agents: currentAgentStates(),
        messages: ctx?.messages.list() ?? [],
        messageHistory: ctx?.messages.historyState() ?? emptyMessageHistory(),
        terminal: ctx?.transcripts.all() ?? {},
        runningSummaries: buildRunningSummaries(),
        runtimeAvailability: getRuntimeAvailabilityArray(),
      });
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
      if (!activeWorkspaceId || !activeConversationId) {
        sendJson(res, 409, { ok: false, message: "No active conversation." });
        return;
      }
      const input = (await readJson(req)) as {
        data?: unknown;
        mimeType?: unknown;
        filename?: unknown;
      };
      const base64Data = typeof input.data === "string" ? input.data : "";
      const mimeType = typeof input.mimeType === "string" ? input.mimeType : "";
      const filename = typeof input.filename === "string" ? input.filename : "image.png";

      if (!base64Data) {
        sendJson(res, 400, { ok: false, message: "Missing image data." });
        return;
      }

      const buffer = Buffer.from(base64Data, "base64");
      const validation = AttachmentStore.validateImageFile(buffer, mimeType, filename);
      if (!validation.valid) {
        sendJson(res, 400, { ok: false, message: validation.error });
        return;
      }

      const saved = await attachmentStore.saveDraft({
        workspaceId: activeWorkspaceId,
        conversationId: activeConversationId,
        data: buffer,
        mimeType,
        filename,
      });

      sendJson(res, 200, {
        ok: true,
        attachment: {
          id: saved.id,
          kind: "image",
          mimeType,
          filename,
          size: saved.size,
          previewUrl: `/api/attachments/drafts/${activeWorkspaceId}/${activeConversationId}/${saved.id}`,
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
      res.writeHead(200, {
        "Content-Type": draft.mimeType,
        "Content-Disposition": `inline; filename="${draft.filename}"`,
        "Cache-Control": "private, max-age=86400",
      });
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
      res.writeHead(200, {
        "Content-Type": attachment.mimeType,
        "Content-Disposition": `inline; filename="${attachId}"`,
        "Cache-Control": "private, max-age=86400",
      });
      res.end(attachment.data);
      return;
    }

    // Cancel run (queued runs only)
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
        if (result.reason === "already_running") {
          sendJson(res, 409, { ok: false, reason: "already_running", message: "This run has already started and cannot be cancelled." });
        } else if (result.reason === "not_cancellable") {
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
      sendJson(res, 200, allConfigs);
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

    // --- Workspace config ---

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

    // --- Workspace endpoints ---

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
      const input = (await readJson(req)) as { name?: unknown; path?: unknown };
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const wsPath = typeof input.path === "string" ? input.path.trim() : "";
      if (!wsPath) {
        sendJson(res, 400, { ok: false, message: "path is required." });
        return;
      }
      try {
        const ws = workspaceStore.create(name, wsPath);
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
      const wsId = url.searchParams.get("workspaceId") || activeWorkspaceId;
      if (!wsId) {
        sendJson(res, 409, { ok: false, message: "Create or select a workspace before creating a conversation." });
        return;
      }
      const input = (await readJson(req)) as { name?: unknown };
      const name = conversationTitle(typeof input.name === "string" ? input.name : "");
      // Switch workspace if creating in a different one
      if (wsId !== activeWorkspaceId) {
        switchWorkspace(wsId);
      }
      const conv = conversationStore.create(activeWorkspaceId, name);
      activateConversation(conv);
      publishContextSwitched();
      sendJson(res, 200, conv);
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
          activeConversation = { id: conv.id, name: conv.name };
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
  startPeriodicProbe();
  server.listen(port, () => {
    console.log(`[orbit] listening on http://localhost:${port}`);
  });
})();

// --- Helpers ---

async function handlePostMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const input = (await readJson(req)) as {
    content?: unknown;
    draftAttachments?: unknown;
  };
  const content = typeof input.content === "string" ? input.content.trim() : "";

  if (!content) {
    sendJson(res, 400, { ok: false, message: "Message cannot be empty." });
    return;
  }

  if (!activeWorkspaceId) {
    sendJson(res, 409, { ok: false, message: "Create or select a workspace before sending a message." });
    return;
  }

  let context = getActiveContext();

  if (!context) {
    const conversation = conversationStore.create(activeWorkspaceId, conversationTitle(content));
    activeConversationId = conversation.id;
    activeConversation = { id: conversation.id, name: conversation.name };
    conversationStore.touchLastOpened(activeWorkspaceId, activeConversationId);
    context = getOrCreateContext(activeWorkspaceId, activeConversationId);
    saveLastActive(activeWorkspaceId, activeConversationId);
    publishContextSwitched();
  } else if (activeConversation.name === UNTITLED_CONVERSATION_NAME) {
    const renamed = conversationStore.update(activeWorkspaceId, activeConversationId, { name: conversationTitle(content) });
    activeConversation = { id: renamed.id, name: renamed.name };
    publishContextSwitched();
  }

  if (!context) {
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
    attachments = await attachmentStore.commitDrafts({
      workspaceId: activeWorkspaceId,
      conversationId: activeConversationId,
      draftAttachments,
    });
  }

  const userMessage = context.messages.add({ kind: "user", content, status: "sent", attachments });
  eventBus.publish({ type: "message.created", conversationId: activeConversationId, message: userMessage });
  context.messageRouter.process(userMessage);

  sendJson(res, 200, { ok: true, messageId: userMessage.id });
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

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

  const input = (await readJson(req)) as AgentConfig[];
  if (!Array.isArray(input)) {
    sendJson(res, 400, { ok: false, message: "Request body must be an array of agent configs." });
    return;
  }

  const errors = validateAgentConfigs(input);
  if (errors.length > 0) {
    sendJson(res, 400, { ok: false, message: errors.join(" ") });
    return;
  }

  allConfigs = input;
  configStore.save(activeWorkspaceId, allConfigs);
  refreshEnabledAgents();
  sendJson(res, 200, allConfigs);
}

function shutdown(): void {
  stopPeriodicProbe();
  for (const ctx of contextMap.values()) {
    ctx.dispose();
  }
  contextMap.clear();
  contextLru.length = 0;
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
