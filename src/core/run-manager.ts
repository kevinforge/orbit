import type {
  AgentActivityEvent,
  AgentId,
  ChatMessage,
  NewChatMessage,
  RunResult,
  RuntimeEvent,
} from "../shared/types.ts";
import { randomBytes } from "node:crypto";
import type { EventBus } from "./event-bus.ts";
import type { MessageStore } from "./message-store.ts";
import { parseJsonObjects } from "./json-stream-parser.ts";

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
  conversationId: string;
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
  private readonly chunkBuffers = new Map<string, string>();
  private readonly lastToolNames = new Map<string, string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly options: RunManagerOptions) {
    this.unsubscribe = this.options.eventBus.subscribe((event) => this.handleRuntimeEvent(event));
  }

  dispose(): void {
    this.unsubscribe();
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
      runStatus: isBusy ? "queued" : "running",
      content: isBusy ? `${getAgentLabel(agentId)} queued...` : `${getAgentLabel(agentId)} is working...`,
      status: "running",
      parentMessageId: sourceMessage.id,
      routeDepth,
      activity,
    } satisfies NewChatMessage);
    this.options.eventBus.publish({ type: "message.created", conversationId: this.options.conversationId, message: agentMessage });

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

  cancel(runId: string): { ok: boolean; reason?: "not_found" | "not_cancellable" | "already_running" } {
    const run = this.runs.get(runId);
    if (!run) {
      return { ok: false, reason: "not_found" };
    }

    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return { ok: false, reason: "not_cancellable" };
    }

    if (run.status === "running") {
      return { ok: false, reason: "already_running" };
    }

    // run.status === "queued" — the only cancellable state
    const queue = this.getQueue(run.agentId);
    const idx = queue.findIndex((r) => r.id === runId);
    if (idx !== -1) {
      queue.splice(idx, 1);
    }

    this.markCancelled(run);
    return { ok: true };
  }

  private markCancelled(run: ManagedRun): void {
    run.status = "cancelled";
    run.completedAt = new Date().toISOString();
    this.chunkBuffers.delete(run.id);
    this.lastToolNames.delete(run.id);
    this.appendActivity(run, "Cancelled by user before start.");

    const updated = this.options.messages.update(run.resultMessageId, {
      content: `${getAgentLabel(run.agentId)} queued run was cancelled.`,
      status: "cancelled",
      runStatus: "cancelled",
      activity: run.activity,
      completedAt: run.completedAt,
      startedAt: run.startedAt,
    });
    this.options.eventBus.publish({ type: "message.updated", conversationId: this.options.conversationId, message: updated });
    this.options.eventBus.publish({
      type: "run.cancelled",
      conversationId: this.options.conversationId,
      agentId: run.agentId,
      runId: run.id,
      resultMessageId: updated.id,
    });
  }

  private start(run: ManagedRun): void {
    run.status = "running";
    run.startedAt = new Date().toISOString();
    this.active.set(run.agentId, run);

    // Reflect runStatus transition on the UI message
    this.options.messages.update(run.resultMessageId, {
      content: `${getAgentLabel(run.agentId)} is working...`,
      runStatus: "running",
      startedAt: run.startedAt,
    });

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
    if (run.status === "cancelled") {
      return;
    }
    run.status = "completed";
    run.completedAt = new Date().toISOString();
    this.active.delete(run.agentId);
    this.chunkBuffers.delete(run.id);
    this.lastToolNames.delete(run.id);
    this.appendActivity(run, "Run completed.");

    const updated = this.options.messages.update(run.resultMessageId, {
      content: runResult.content,
      status: "done",
      runStatus: "completed",
      activity: run.activity,
      completedAt: run.completedAt,
      startedAt: run.startedAt,
      sessionId: runResult.sessionId,
      runIndex: runResult.runIndex,
    });
    this.options.eventBus.publish({ type: "message.updated", conversationId: this.options.conversationId, message: updated });
    this.options.eventBus.publish({
      type: "run.completed",
      conversationId: this.options.conversationId,
      agentId: run.agentId,
      runId: run.id,
      resultMessageId: updated.id,
    });
    this.options.onRunCompleted(updated);
    this.startNext(run.agentId);
  }

  private fail(run: ManagedRun, error: string): void {
    if (run.status === "cancelled") {
      return;
    }
    const errorSummary = summarizeRunError(error);
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    this.active.delete(run.agentId);
    this.chunkBuffers.delete(run.id);
    this.lastToolNames.delete(run.id);
    this.appendActivity(run, `Run failed: ${errorSummary}`);

    const updated = this.options.messages.update(run.resultMessageId, {
      content: `${getAgentLabel(run.agentId)} failed: ${errorSummary}`,
      status: "error",
      runStatus: "failed",
      activity: run.activity,
      completedAt: run.completedAt,
      startedAt: run.startedAt,
    });
    this.options.eventBus.publish({ type: "message.updated", conversationId: this.options.conversationId, message: updated });
    this.options.eventBus.publish({ type: "run.failed", conversationId: this.options.conversationId, agentId: run.agentId, runId: run.id, error: errorSummary });
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
      runStatus: "running",
      activity: next.activity,
      startedAt,
    });
    this.options.eventBus.publish({ type: "message.updated", conversationId: this.options.conversationId, message: updated });
    this.start(next);
  }

  private appendActivity(run: ManagedRun, text: string): void {
    const activity = createActivity(text);
    this.appendActivityEvent(run, activity);
  }

  private appendActivityEvent(run: ManagedRun, activity: AgentActivityEvent): void {
    run.activity.push(truncateActivity(activity));
    this.options.messages.update(run.resultMessageId, {
      activity: run.activity,
    });
    this.options.eventBus.publish({ type: "run.activity", conversationId: this.options.conversationId, agentId: run.agentId, runId: run.id, activity: run.activity[run.activity.length - 1]! });
  }

  private handleRuntimeEvent(event: RuntimeEvent): void {
    // Only process events for our own conversation
    if ("conversationId" in event && event.conversationId !== this.options.conversationId) return;

    if (event.type === "run.sessionId" && event.runId) {
      const run = this.runs.get(event.runId);
      if (run && run.status === "running") {
        const updated = this.options.messages.update(run.resultMessageId, {
          sessionId: event.sessionId,
        });
        this.options.eventBus.publish({ type: "message.updated", conversationId: this.options.conversationId, message: updated });
      }
      return;
    }

    if (event.type !== "terminal.chunk" || !event.runId) {
      return;
    }

    const run = this.runs.get(event.runId);
    if (!run || run.status !== "running") {
      return;
    }

    const { complete, nonJson } = this.flushChunkBuffer(run.id, event.text);
    const allActivities: AgentActivityEvent[] = [];

    if (nonJson) {
      allActivities.push(...classifyTerminalActivities(nonJson));
    }
    if (complete) {
      allActivities.push(...classifyTerminalActivities(complete));
    }

    for (const activity of allActivities) {
      if (activity.type === "tool.started") {
        this.lastToolNames.set(run.id, activity.name);
      }
      if ((activity.type === "tool.completed" || activity.type === "tool.failed") && activity.name === "tool") {
        const lastName = this.lastToolNames.get(run.id);
        if (lastName) {
          (activity as { name: string }).name = lastName;
        }
      }
    }

    const activities = allActivities;
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

  private flushChunkBuffer(runId: string, incoming: string): { complete: string; nonJson: string } {
    const prev = this.chunkBuffers.get(runId) ?? "";

    if (!prev) {
      const lastBrace = findLastTopLevelClose(incoming);
      if (lastBrace === -1) {
        const startsLikeJson = /^\s*\{/.test(incoming);
        if (startsLikeJson) {
          this.chunkBuffers.set(runId, incoming);
          return { complete: "", nonJson: "" };
        }
        return { complete: "", nonJson: incoming };
      }
      const complete = incoming.slice(0, lastBrace + 1);
      const tail = incoming.slice(lastBrace + 1).replace(/^\s+/, "");
      if (tail) {
        this.chunkBuffers.set(runId, tail);
      } else {
        this.chunkBuffers.delete(runId);
      }
      return { complete, nonJson: "" };
    }

    const combined = prev + incoming;
    const lastBrace = findLastTopLevelClose(combined);
    if (lastBrace === -1) {
      this.chunkBuffers.set(runId, combined);
      return { complete: "", nonJson: "" };
    }

    const complete = combined.slice(0, lastBrace + 1);
    const tail = combined.slice(lastBrace + 1).replace(/^\s+/, "");
    if (tail) {
      this.chunkBuffers.set(runId, tail);
    } else {
      this.chunkBuffers.delete(runId);
    }
    return { complete, nonJson: "" };
  }
}

function createRunId(agentId: AgentId): string {
  return `run_${agentId}_${Date.now()}_${randomBytes(8).toString("hex")}`;
}

function createActivity(text: string): AgentActivityEvent {
  return { type: "status", text, timestamp: new Date().toISOString() };
}

function getAgentLabel(agentId: AgentId): string {
  return agentId;
}

function findLastTopLevelClose(text: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastClose = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        lastClose = i;
      }
    }
  }

  return lastClose;
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
  for (const event of parseJsonObjects(text)) {
    try {
      const record = event as {
        type?: string;
        message?: string | { content?: unknown };
        item?: unknown;
        result?: unknown;
        text?: unknown;
        error?: unknown;
        data?: unknown;
        tool_use_result?: { stdout?: unknown; stderr?: unknown; is_error?: unknown };
      };

      const codexActivity = activityFromCodexItem(record.item, record.type);
      if (codexActivity) {
        activities.push(codexActivity);
      }

      if (record.type === "error") {
        const message = typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : "";
        if (message) {
          activities.push({
            type: "error",
            message: truncateText(message, MAX_ACTIVITY_TEXT_CHARS),
            timestamp: new Date().toISOString(),
          });
        }
      }

      const message = typeof record.message === "object" && record.message ? record.message as { content?: unknown } : null;
      if (record.type === "assistant" && Array.isArray(message?.content)) {
        for (const part of message.content as Array<{ type?: unknown; name?: unknown; input?: unknown }>) {
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

      if (record.type === "user" && record.tool_use_result) {
        const isError = !!record.tool_use_result.is_error;
        const lastToolName = findLastToolName(activities);
        if (isError) {
          const summary = summarizeFailedToolResult(record.tool_use_result);
          activities.push({
            type: "tool.failed",
            name: lastToolName,
            summary,
            timestamp: new Date().toISOString(),
          });
        } else {
          activities.push({
            type: "tool.completed",
            name: lastToolName,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch {
      continue;
    }
  }

  return activities;
}

const MAX_RUN_ERROR_CHARS = 2_000;
const MAX_ACTIVITY_TEXT_CHARS = 2_000;
const MAX_TOOL_SUMMARY_CHARS = 120;

function activityFromCodexItem(item: unknown, eventType: unknown): AgentActivityEvent | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const record = item as {
    type?: unknown;
    command?: unknown;
    aggregated_output?: unknown;
    exit_code?: unknown;
    status?: unknown;
  };

  if (record.type !== "command_execution") {
    return null;
  }

  const name = commandToolName(record.command);
  if (eventType === "item.started") {
    return {
      type: "tool.started",
      name,
      input: typeof record.command === "string" ? truncateText(record.command, MAX_TOOL_SUMMARY_CHARS) : undefined,
      timestamp: new Date().toISOString(),
    };
  }

  if (eventType !== "item.completed") {
    return null;
  }

  if (typeof record.exit_code === "number" && record.exit_code !== 0) {
    const summary = summarizeCodexCommandOutput(record.aggregated_output);
    return {
      type: "tool.failed",
      name,
      summary: summary || `exit ${record.exit_code}`,
      timestamp: new Date().toISOString(),
    };
  }

  if (record.status === "failed") {
    const summary = summarizeCodexCommandOutput(record.aggregated_output);
    return {
      type: "tool.failed",
      name,
      summary: summary || "failed",
      timestamp: new Date().toISOString(),
    };
  }

  return {
    type: "tool.completed",
    name,
    timestamp: new Date().toISOString(),
  };
}

function commandToolName(command: unknown): string {
  if (typeof command !== "string") {
    return "Command";
  }

  if (/powershell|pwsh/i.test(command)) return "PowerShell";
  if (/\b(cmd\.exe|cmd)\b/i.test(command)) return "Command";
  if (/\b(bash|sh|zsh)\b/i.test(command)) return "Bash";
  return "Command";
}

function summarizeCodexCommandOutput(output: unknown): string | undefined {
  if (typeof output !== "string") {
    return undefined;
  }

  const summary = output.replace(/\s+/g, " ").trim();
  if (!summary) {
    return undefined;
  }

  return truncateText(summary, MAX_TOOL_SUMMARY_CHARS);
}

function truncateActivity(activity: AgentActivityEvent): AgentActivityEvent {
  if (activity.type === "status") {
    return { ...activity, text: truncateText(activity.text, MAX_ACTIVITY_TEXT_CHARS) };
  }
  if (activity.type === "error") {
    return { ...activity, message: truncateText(activity.message, MAX_ACTIVITY_TEXT_CHARS) };
  }
  if (activity.type === "tool.started") {
    return { ...activity, input: activity.input ? truncateText(activity.input, MAX_TOOL_SUMMARY_CHARS) : undefined };
  }
  if (activity.type === "tool.completed" || activity.type === "tool.failed") {
    return { ...activity, summary: activity.summary ? truncateText(activity.summary, MAX_TOOL_SUMMARY_CHARS) : undefined };
  }
  return activity;
}

function summarizeRunError(error: string): string {
  const normalized = error.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Runtime failed without an error message. Check the transcript for details.";
  }

  return truncateText(stripRawJsonNoise(normalized), MAX_RUN_ERROR_CHARS);
}

function stripRawJsonNoise(value: string): string {
  if (!value.includes("{\"type\":")) {
    return value;
  }

  const parsedMessages = parseJsonObjects(value)
    .map((event) => {
      const record = event as {
        type?: unknown;
        message?: { content?: unknown };
        error?: unknown;
        result?: unknown;
        item?: { type?: unknown; exit_code?: unknown; status?: unknown; aggregated_output?: unknown };
      };

      if (typeof record.error === "string") return record.error;
      if (typeof record.message === "string") return record.message;
      if (typeof record.result === "string") return record.result;
      if (record.item?.type === "command_execution" && record.item.status === "failed") {
        const output = typeof record.item.aggregated_output === "string" ? record.item.aggregated_output : "";
        return output || `Command failed${typeof record.item.exit_code === "number" ? ` with exit ${record.item.exit_code}` : ""}`;
      }
      return "";
    })
    .filter(Boolean);

  if (parsedMessages.length > 0) {
    return parsedMessages.join(" ");
  }

  return "Runtime failed. Check the transcript for details.";
}

function findLastToolName(activities: AgentActivityEvent[]): string {
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (activity?.type === "tool.started") {
      return activity.name;
    }
  }
  return "tool";
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

function summarizeFailedToolResult(result: { stdout?: unknown; stderr?: unknown }): string {
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const summary = stderr || stdout;
  if (!summary) {
    return "failed";
  }

  return truncateText(summary, MAX_TOOL_SUMMARY_CHARS);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}
