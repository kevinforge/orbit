import http from "node:http";
import path from "node:path";

import { createDefaultAgentProfiles, parseAgentRuntimeOverrides } from "../core/agent-profiles.ts";
import { AgentRegistry } from "../core/agent-registry.ts";
import { ChannelRouter } from "../core/channel-router.ts";
import { buildChannelContext } from "../core/channel-context-builder.ts";
import { buildHistoryForAgent } from "../core/channel-history.ts";
import { EventBus } from "../core/event-bus.ts";
import { MessageStore } from "../core/message-store.ts";
import { RunManager } from "../core/run-manager.ts";
import { SessionStore } from "../core/session-store.ts";
import { TerminalTranscriptStore } from "../core/terminal-transcript-store.ts";
import { WorkspaceStore } from "../core/workspace-store.ts";
import type { AgentId } from "../shared/types.ts";
import { serveStatic } from "./static-server.ts";
import { SseHub } from "./sse-hub.ts";

const MAX_ROUTE_DEPTH = 5;
const CHANNEL_ID = "default";
const CONVERSATION_ID = "default";
const port = Number(process.env.ORBIT_PORT ?? 4317);

const eventBus = new EventBus();
const sseHub = new SseHub();
const workspaceStore = new WorkspaceStore();
const workspace = workspaceStore.resolve(process.cwd());
const messagesPath = path.join(workspaceStore.channelsDir(workspace.id), "messages.json");
const transcriptsDir = workspaceStore.transcriptsDir(workspace.id);
const messages = new MessageStore(messagesPath);
const transcripts = new TerminalTranscriptStore(transcriptsDir);
const sessionStore = new SessionStore(workspaceStore.sessionsDir(workspace.id));
const profiles = createDefaultAgentProfiles(
  process.cwd(),
  parseAgentRuntimeOverrides(process.env.ORBIT_AGENT_RUNTIMES),
);
const agents = new AgentRegistry(profiles, eventBus, sessionStore, CHANNEL_ID, CONVERSATION_ID);
const agentIds = agents.ids();

eventBus.subscribe((event) => {
  if (event.type === "terminal.chunk") {
    transcripts.append(event.agentId, event.text);
  }
  sseHub.publish(event);
});

agents.startAll();

let channelRouter: ChannelRouter;

const runManager = new RunManager({
  agents,
  messages,
  eventBus,
  buildPrompt(agentId: AgentId, prompt: string) {
    const history = buildHistoryForAgent(agentId, messages.list());
    return buildChannelContext({ agentId, profiles, channelMessage: prompt, history });
  },
  onRunCompleted(message) {
    channelRouter.process(message);
  },
});

channelRouter = new ChannelRouter({
  availableAgents: agentIds,
  maxRouteDepth: MAX_ROUTE_DEPTH,
  createSystemMessage(content: string, parentMessageId?: string) {
    const msg = messages.add({ kind: "system", content, status: "done", parentMessageId });
    eventBus.publish({ type: "message.created", message: msg });
    return msg;
  },
  startAgentRun(agentId: AgentId, prompt: string, sourceMessage) {
    runManager.enqueue(agentId, prompt, sourceMessage);
  },
  markMessageRouted(messageId: string, routeState) {
    messages.markRouteState(messageId, routeState);
  },
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/events") {
      sseHub.add(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, 200, {
        workspace,
        agents: agents.states(),
        messages: messages.list(),
        terminal: transcripts.all(),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/messages") {
      await handlePostMessage(req, res);
      return;
    }

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

async function handlePostMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const input = (await readJson(req)) as { content?: unknown };
  const content = typeof input.content === "string" ? input.content.trim() : "";

  if (!content) {
    sendJson(res, 400, { ok: false, message: "Message cannot be empty." });
    return;
  }

  const userMessage = messages.add({ kind: "user", content, status: "sent" });
  eventBus.publish({ type: "message.created", message: userMessage });

  channelRouter.process(userMessage);

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

function shutdown(): void {
  agents.stopAll();
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
