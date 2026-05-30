import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { configsToProfiles } from "../core/agent-profiles.ts";
import { AgentConfigStore, validateAgentConfigs } from "../core/agent-config-store.ts";
import type { AgentConfig } from "../core/agent-config-store.ts";
import { ConversationStore } from "../core/conversation-store.ts";
import { EventBus } from "../core/event-bus.ts";
import { MessageStore } from "../core/message-store.ts";
import { SessionStore } from "../core/session-store.ts";
import { WorkspaceStore } from "../core/workspace-store.ts";
import type { Conversation, ConversationInfo, WorkspaceInfo } from "../shared/types.ts";
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
let activeContext: ConversationContext | null = null;
let allConfigs: AgentConfig[] = [];
let conversationStore: ConversationStore;
let sessionStore: SessionStore | null = null;

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

function activateConversation(conversation: Conversation): void {
  activeContext?.dispose();
  if (!sessionStore) {
    sessionStore = new SessionStore(workspaceStore.sessionsDir(activeWorkspaceId));
  }
  activeConversationId = conversation.id;
  activeConversation = { id: conversation.id, name: conversation.name };
  conversationStore.touchLastOpened(activeWorkspaceId, activeConversationId);
  const enabledConfigs = allConfigs.filter((c) => c.enabled);
  const profiles = configsToProfiles(enabledConfigs, activeWorkspace.path);
  activeContext = new ConversationContext({
    workspaceId: activeWorkspaceId,
    conversationId: activeConversationId,
    profiles,
    eventBus,
    sessionStore,
    workspaceStore,
    sseHub,
  });
  saveLastActive(activeWorkspaceId, activeConversationId);
}

function switchWorkspace(workspaceId: string): void {
  if (workspaceId === activeWorkspaceId) return;
  if (activeContext?.hasRunningAgent()) {
    throw new Error("Cannot switch workspace while an agent is running.");
  }

  const ws = workspaceStore.get(workspaceId);
  if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);

  activeContext?.dispose();
  activeContext = null;

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
  if (activeContext?.hasRunningAgent()) {
    throw new Error("Cannot switch conversation while an agent is running.");
  }

  const conv = conversationStore.get(activeWorkspaceId, conversationId);
  if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

  activateConversation(conv);
  publishContextSwitched();
}

function refreshEnabledAgents(): void {
  if (!activeContext || !activeWorkspaceId) return;
  const enabledConfigs = allConfigs.filter((c) => c.enabled);
  const profiles = configsToProfiles(enabledConfigs, activeWorkspace.path);
  activeContext.refreshProfiles(profiles);
}

function publishContextSwitched(): void {
  sseHub.publish({
    type: "context.switched",
    workspace: activeWorkspace,
    conversation: activeConversation,
  });
}

function currentAgentStates() {
  if (activeContext) {
    return activeContext.agents.states();
  }
  return allConfigs
    .filter((config) => config.enabled)
    .map((config, index) => ({
      id: config.id,
      label: config.name,
      runtime: config.runtime,
      status: "idle" as const,
      selected: index === 0,
    }));
}

// --- Initialize ---
initActiveContext();

// --- HTTP Server ---
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
      sendJson(res, 200, {
        workspace: activeWorkspace,
        conversation: activeConversation,
        agents: currentAgentStates(),
        messages: activeContext?.messages.list() ?? [],
        terminal: activeContext?.transcripts.all() ?? {},
      });
      return;
    }

    // Messages
    if (req.method === "POST" && url.pathname === "/api/messages") {
      await handlePostMessage(req, res);
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
      if (activeContext?.hasRunningAgent()) {
        sendJson(res, 409, { ok: false, message: "Cannot reset while an agent is running. Wait for it to finish." });
        return;
      }
      allConfigs = configStore.reset(activeWorkspaceId);
      refreshEnabledAgents();
      sendJson(res, 200, allConfigs);
      return;
    }

    // --- Workspace endpoints ---

    if (req.method === "POST" && url.pathname === "/api/workspaces/pick-directory") {
      const directory = await pickWindowsDirectory();
      sendJson(res, 200, { path: directory });
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
      if (wsId === activeWorkspaceId) {
        sendJson(res, 400, { ok: false, message: "Cannot delete the active workspace. Switch to another first." });
        return;
      }
      try {
        workspaceStore.delete(wsId);
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

    if (req.method === "POST" && url.pathname === "/api/conversations") {
      if (!activeWorkspaceId) {
        sendJson(res, 409, { ok: false, message: "Create or select a workspace before creating a conversation." });
        return;
      }
      const input = (await readJson(req)) as { name?: unknown };
      const name = conversationTitle(typeof input.name === "string" ? input.name : "");
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
      const input = (await readJson(req)) as { name?: unknown };
      const name = typeof input.name === "string" ? input.name.trim() : undefined;
      try {
        const conv = conversationStore.update(activeWorkspaceId, convId, { name });
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
      if (convId === activeConversationId) {
        sendJson(res, 400, { ok: false, message: "Cannot delete the active conversation. Switch to another first." });
        return;
      }
      try {
        conversationStore.delete(activeWorkspaceId, convId);
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

server.listen(port, () => {
  console.log(`[orbit] listening on http://localhost:${port}`);
});

// --- Helpers ---

async function handlePostMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const input = (await readJson(req)) as { content?: unknown };
  const content = typeof input.content === "string" ? input.content.trim() : "";

  if (!content) {
    sendJson(res, 400, { ok: false, message: "Message cannot be empty." });
    return;
  }

  if (!activeWorkspaceId) {
    sendJson(res, 409, { ok: false, message: "Create or select a workspace before sending a message." });
    return;
  }

  if (!activeContext) {
    const conversation = conversationStore.create(activeWorkspaceId, conversationTitle(content));
    activateConversation(conversation);
    publishContextSwitched();
  } else if (activeConversation.name === UNTITLED_CONVERSATION_NAME) {
    const renamed = conversationStore.update(activeWorkspaceId, activeConversationId, { name: conversationTitle(content) });
    activeConversation = { id: renamed.id, name: renamed.name };
    publishContextSwitched();
  }

  const context = activeContext;
  if (!context) {
    sendJson(res, 500, { ok: false, message: "Conversation context was not initialized." });
    return;
  }

  const userMessage = context.messages.add({ kind: "user", content, status: "sent" });
  eventBus.publish({ type: "message.created", message: userMessage });
  context.channelRouter.process(userMessage);

  sendJson(res, 200, { ok: true, messageId: userMessage.id });
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
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

function conversationTitle(content: string): string {
  const title = content.replace(/\s+/g, " ").trim();
  if (!title) {
    return UNTITLED_CONVERSATION_NAME;
  }
  return title.length > 24 ? `${title.slice(0, 24)}...` : title;
}

async function pickWindowsDirectory(): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Directory picker is currently only supported on Windows.");
  }

  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = '选择工作区目录'",
    "$dialog.ShowNewFolderButton = $true",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "  Write-Output $dialog.SelectedPath",
    "}",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
    windowsHide: false,
  });
  return stdout.trim();
}

async function handlePutAgents(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!activeWorkspaceId) {
    sendJson(res, 409, { ok: false, message: "Create or select a workspace before saving agents." });
    return;
  }
  if (activeContext?.hasRunningAgent()) {
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
  activeContext?.dispose();
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
