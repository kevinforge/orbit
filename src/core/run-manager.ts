import type {
  AgentActivityEvent,
  AgentId,
  ChatMessage,
  NewChatMessage,
  RunResult,
  RuntimeEvent,
} from "../shared/types.ts";
import type { EventBus } from "./event-bus.ts";
import type { MessageStore } from "./message-store.ts";

type AgentRunner = {
  get(agentId: AgentId): {
    send(runId: string, prompt: string): Promise<RunResult>;
  };
};

export type ManagedRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type ManagedRun = {
  id: string;
  agentId: AgentId;
  prompt: string;
  sourceMessage: ChatMessage;
  resultMessageId: string;
  status: ManagedRunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  activity: AgentActivityEvent[];
};

export type RunManagerOptions = {
  agents: AgentRunner;
  messages: MessageStore;
  eventBus: EventBus;
  buildPrompt: (agentId: AgentId, prompt: string) => string;
  onRunCompleted: (message: ChatMessage) => void;
};

export class RunManager {
  private readonly queues = new Map<AgentId, ManagedRun[]>();
  private readonly active = new Map<AgentId, ManagedRun>();
  private readonly runs = new Map<string, ManagedRun>();
  private readonly lastTerminalActivityAt = new Map<string, number>();

  constructor(private readonly options: RunManagerOptions) {
    this.options.eventBus.subscribe((event) => this.handleRuntimeEvent(event));
  }

  enqueue(agentId: AgentId, prompt: string, sourceMessage: ChatMessage): ManagedRun {
    const runId = createRunId(agentId);
    const routeDepth = (sourceMessage.routeDepth ?? 0) + 1;
    const isBusy = this.active.has(agentId);
    const now = new Date().toISOString();
    const activity = [
      createActivity(isBusy ? "Queued behind the current run." : "Run accepted and starting."),
    ];

    const agentMessage = this.options.messages.add({
      kind: "agent",
      agentId,
      runId,
      content: isBusy ? `${getAgentLabel(agentId)} queued...` : `${getAgentLabel(agentId)} is working...`,
      status: "running",
      parentMessageId: sourceMessage.id,
      routeDepth,
      activity,
    } satisfies NewChatMessage);
    this.options.eventBus.publish({ type: "message.created", message: agentMessage });

    const run: ManagedRun = {
      id: runId,
      agentId,
      prompt,
      sourceMessage,
      resultMessageId: agentMessage.id,
      status: isBusy ? "queued" : "running",
      createdAt: now,
      startedAt: isBusy ? undefined : now,
      activity,
    };
    this.runs.set(run.id, run);

    if (isBusy) {
      this.getQueue(agentId).push(run);
      return run;
    }

    this.active.set(agentId, run);
    this.start(run);
    return run;
  }

  private start(run: ManagedRun): void {
    run.status = "running";
    run.startedAt = new Date().toISOString();
    this.active.set(run.agentId, run);
    this.appendActivity(run, "Run started.");

    const runtimePrompt = this.options.buildPrompt(run.agentId, run.prompt);
    let result: Promise<RunResult>;
    try {
      result = this.options.agents.get(run.agentId).send(run.id, runtimePrompt);
    } catch (error: unknown) {
      this.fail(run, error instanceof Error ? error.message : String(error));
      return;
    }

    void result
      .then((runResult) => this.complete(run, runResult))
      .catch((error: unknown) => this.fail(run, error instanceof Error ? error.message : String(error)));
  }

  private complete(run: ManagedRun, runResult: RunResult): void {
    run.status = "completed";
    run.completedAt = new Date().toISOString();
    this.active.delete(run.agentId);
    this.appendActivity(run, "Run completed.");

    const updated = this.options.messages.update(run.resultMessageId, {
      content: runResult.content,
      status: "done",
      activity: run.activity,
      completedAt: run.completedAt,
      startedAt: run.startedAt,
      sessionId: runResult.sessionId,
      runIndex: runResult.runIndex,
    });
    this.options.eventBus.publish({ type: "message.updated", message: updated });
    this.options.eventBus.publish({
      type: "run.completed",
      agentId: run.agentId,
      runId: run.id,
      resultMessageId: updated.id,
    });
    this.options.onRunCompleted(updated);
    this.startNext(run.agentId);
  }

  private fail(run: ManagedRun, error: string): void {
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    this.active.delete(run.agentId);
    this.appendActivity(run, `Run failed: ${error}`);

    const updated = this.options.messages.update(run.resultMessageId, {
      content: `${getAgentLabel(run.agentId)} failed: ${error}`,
      status: "error",
      activity: run.activity,
      completedAt: run.completedAt,
      startedAt: run.startedAt,
    });
    this.options.eventBus.publish({ type: "message.updated", message: updated });
    this.options.eventBus.publish({ type: "run.failed", agentId: run.agentId, runId: run.id, error });
    this.startNext(run.agentId);
  }

  private startNext(agentId: AgentId): void {
    const next = this.getQueue(agentId).shift();
    if (!next) {
      return;
    }

    const startedAt = new Date().toISOString();
    const updated = this.options.messages.update(next.resultMessageId, {
      content: `${getAgentLabel(agentId)} is working...`,
      status: "running",
      activity: next.activity,
      startedAt,
    });
    this.options.eventBus.publish({ type: "message.updated", message: updated });
    this.start(next);
  }

  private appendActivity(run: ManagedRun, text: string): void {
    const activity = createActivity(text);
    this.appendActivityEvent(run, activity);
  }

  private appendActivityEvent(run: ManagedRun, activity: AgentActivityEvent): void {
    run.activity.push(activity);
    this.options.messages.update(run.resultMessageId, {
      activity: run.activity,
    });
    this.options.eventBus.publish({ type: "run.activity", agentId: run.agentId, runId: run.id, activity });
  }

  private handleRuntimeEvent(event: RuntimeEvent): void {
    if (event.type !== "terminal.chunk" || !event.runId) {
      return;
    }

    const run = this.runs.get(event.runId);
    if (!run || run.status !== "running") {
      return;
    }

    const activities = classifyTerminalActivities(event.text);
    if (activities.length === 0) {
      return;
    }

    for (const activity of activities) {
      const now = Date.now();
      const previous = this.lastTerminalActivityAt.get(run.id) ?? 0;
      if (activity.type === "status" && now - previous < 10_000) {
        continue;
      }

      if (activity.type === "status") {
        this.lastTerminalActivityAt.set(run.id, now);
      }
      this.appendActivityEvent(run, activity);
    }
  }

  private getQueue(agentId: AgentId): ManagedRun[] {
    const queue = this.queues.get(agentId);
    if (queue) {
      return queue;
    }

    const nextQueue: ManagedRun[] = [];
    this.queues.set(agentId, nextQueue);
    return nextQueue;
  }
}

function createRunId(agentId: AgentId): string {
  return `run_${agentId}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function createActivity(text: string): AgentActivityEvent {
  return { type: "status", text, timestamp: new Date().toISOString() };
}

function getAgentLabel(agentId: AgentId): string {
  return agentId;
}

export function classifyTerminalActivity(text: string): AgentActivityEvent | null {
  return classifyTerminalActivities(text)[0] ?? null;
}

export function classifyTerminalActivities(text: string): AgentActivityEvent[] {
  const jsonActivities = extractStreamJsonActivities(text);
  if (jsonActivities.length > 0) {
    return jsonActivities;
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  if (/api error|hook error|failed with/i.test(normalized)) {
    return [{ type: "error", message: "Runtime reported an error. Waiting for final result.", timestamp: new Date().toISOString() }];
  }

  const toolMatch = /\b(Bash|Edit|Write|Read|Grep|Glob|LS|TodoWrite|MultiEdit|NotebookEdit)\b/i.exec(normalized);
  if (toolMatch) {
    return [{ type: "tool.started", name: toolMatch[1], timestamp: new Date().toISOString() }];
  }

  if (/running|thinking|synthesizing|brewing|twisting|fiddl/i.test(normalized)) {
    return [{ type: "status", text: "Claude Code is still working.", timestamp: new Date().toISOString() }];
  }

  return [{ type: "status", text: "Runtime produced output.", timestamp: new Date().toISOString() }];
}

function extractStreamJsonActivities(text: string): AgentActivityEvent[] {
  const activities: AgentActivityEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        message?: { content?: unknown };
        tool_use_result?: { stdout?: unknown; stderr?: unknown; is_error?: unknown };
      };

      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const part of event.message.content as Array<{ type?: unknown; name?: unknown; input?: unknown }>) {
          if (part.type === "tool_use" && typeof part.name === "string") {
            activities.push({
              type: "tool.started",
              name: part.name,
              input: summarizeToolInput(part.input),
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      if (event.type === "user" && event.tool_use_result) {
        const summary = summarizeToolResult(event.tool_use_result);
        activities.push({
          type: "tool.completed",
          name: "tool",
          summary,
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      continue;
    }
  }

  return activities;
}

function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const value = input as Record<string, unknown>;
  const command = typeof value.command === "string" ? value.command : undefined;
  const filePath = typeof value.file_path === "string" ? value.file_path : undefined;
  const pattern = typeof value.pattern === "string" ? value.pattern : undefined;
  return command ?? filePath ?? pattern;
}

function summarizeToolResult(result: { stdout?: unknown; stderr?: unknown; is_error?: unknown }): string {
  if (result.is_error) {
    return "failed";
  }

  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const summary = stdout || stderr;
  if (!summary) {
    return "completed";
  }

  return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
}
