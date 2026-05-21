import http from "node:http";

import { AgentRegistry } from "../core/agent-registry.ts";
import { EventBus } from "../core/event-bus.ts";
import { MessageStore } from "../core/message-store.ts";
import { routeMention } from "../core/mention-router.ts";
import { TerminalTranscriptStore } from "../core/terminal-transcript-store.ts";
import type { AgentId } from "../shared/types.ts";
import { serveStatic } from "./static-server.ts";
import { SseHub } from "./sse-hub.ts";

const AGENT_IDS = ["agent1", "agent2"] as const;
const port = Number(process.env.ORBIT_PORT ?? 4317);

const eventBus = new EventBus();
const sseHub = new SseHub();
const messages = new MessageStore();
const transcripts = new TerminalTranscriptStore();
const agents = new AgentRegistry(process.cwd(), eventBus);

eventBus.subscribe((event) => {
  if (event.type === "terminal.chunk") {
    transcripts.append(event.agentId, event.text);
  }
  sseHub.publish(event);
});

agents.startAll();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/events") {
      sseHub.add(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, 200, {
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

    if (req.method === "POST" && url.pathname === "/api/hooks/claude-stop") {
      await handleClaudeStopHook(req, res);
      return;
    }

    const terminalMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/terminal$/);
    if (req.method === "POST" && terminalMatch) {
      await handlePostTerminal(req, res, terminalMatch[1]);
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
    sendJson(res, 400, { ok: false, message: "消息不能为空。" });
    return;
  }

  const userMessage = messages.add({ kind: "user", content, status: "sent" });
  eventBus.publish({ type: "message.created", message: userMessage });

  const route = routeMention(content, AGENT_IDS);
  if (!route.ok) {
    const systemMessage = messages.add({ kind: "system", content: route.message, status: "done" });
    eventBus.publish({ type: "message.created", message: systemMessage });
    sendJson(res, 200, { ok: false, message: route.message });
    return;
  }

  const runId = createRunId(route.agentId);
  const agentMessage = messages.add({
    kind: "agent",
    agentId: route.agentId,
    runId,
    content: `${getAgentLabel(route.agentId)} 正在处理...`,
    status: "running",
  });
  eventBus.publish({ type: "message.created", message: agentMessage });
  sendJson(res, 202, { ok: true, runId, messageId: agentMessage.id });

  void agents
    .get(route.agentId)
    .send(runId, route.prompt)
    .then((result) => {
      const updated = messages.update(agentMessage.id, {
        content: result,
        status: "done",
      });
      eventBus.publish({ type: "message.updated", message: updated });
      eventBus.publish({
        type: "run.completed",
        agentId: route.agentId,
        runId,
        resultMessageId: updated.id,
      });
    })
    .catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const updated = messages.update(agentMessage.id, {
        content: `${getAgentLabel(route.agentId)} 执行失败：${errorMessage}`,
        status: "error",
      });
      eventBus.publish({ type: "message.updated", message: updated });
      eventBus.publish({ type: "run.failed", agentId: route.agentId, runId, error: errorMessage });
    });
}

async function handleClaudeStopHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const input = (await readJson(req)) as {
    agentId?: unknown;
    lastAssistantMessage?: unknown;
  };

  const agentIdRaw = String(input.agentId ?? "");
  if (!isAgentId(agentIdRaw)) {
    sendJson(res, 400, { ok: false, message: "未知 Agent。" });
    return;
  }

  const lastAssistantMessage = typeof input.lastAssistantMessage === "string" ? input.lastAssistantMessage : "";
  const completed = agents.completeFromHook(agentIdRaw, lastAssistantMessage);
  sendJson(res, 200, { ok: true, completed });
}

async function handlePostTerminal(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentIdRaw: string,
): Promise<void> {
  if (!isAgentId(agentIdRaw)) {
    sendJson(res, 404, { ok: false, message: "未知 Agent。" });
    return;
  }

  const input = (await readJson(req)) as { input?: unknown };
  const text = typeof input.input === "string" ? input.input : "";
  agents.get(agentIdRaw).writeRaw(text);
  sendJson(res, 200, { ok: true });
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

function createRunId(agentId: AgentId): string {
  return `run_${agentId}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isAgentId(value: string): value is AgentId {
  return value === "agent1" || value === "agent2";
}

function getAgentLabel(agentId: AgentId): string {
  return agentId === "agent1" ? "Agent 1" : "Agent 2";
}

function shutdown(): void {
  agents.stopAll();
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
