import type {
  AgentId,
  ChatMessage,
  Conversation,
  WorkAnalysis,
  WorkTask,
  WorkTaskAgent,
  WorkTaskRun,
  WorkTaskRunStatus,
  WorkTaskStatus,
} from "../shared/types.ts";
import { assignmentPattern } from "./mention-router.ts";

export type ConversationMessages = {
  conversation: Conversation;
  messages: ChatMessage[];
};

export type BuildWorkAnalysisOptions = {
  workspaceId: string;
  conversations: ConversationMessages[];
  agentLabels: ReadonlyMap<AgentId, string>;
  days: number;
  now?: Date;
};

/**
 * Lower-bound timestamp (ms) of the analysis window: the local start-of-day
 * `days` ago. Shared with the read path so the window-bounded shard scan uses
 * exactly the same cutoff the precise task filter does.
 */
export function workAnalysisSinceMs(now: Date, days: number): number {
  const dayCount = Math.max(1, Math.floor(days));
  const since = startOfLocalDay(new Date(now.getTime()));
  since.setDate(since.getDate() - (dayCount - 1));
  return since.getTime();
}

export function buildWorkAnalysis(options: BuildWorkAnalysisOptions): WorkAnalysis {
  const now = options.now ?? new Date();
  const days = Math.max(1, Math.floor(options.days));
  const sinceMs = workAnalysisSinceMs(now, days);
  const since = new Date(sinceMs);
  const tasks = options.conversations
    .flatMap(({ conversation, messages }) => buildConversationTasks(conversation, messages, options.agentLabels, now))
    .filter((task) => {
      const rangeDate = task.completedAt ?? task.createdAt;
      return Date.parse(rangeDate) >= since.getTime() && Date.parse(rangeDate) <= now.getTime();
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const completed = tasks.filter((task) => task.status === "completed");
  const participatingAgents = new Set(tasks.flatMap((task) => task.agents.map((agent) => agent.agentId))).size;
  const multiAgentTasks = tasks.filter((task) => task.agents.length >= 2).length;

  return {
    workspaceId: options.workspaceId,
    days,
    generatedAt: now.toISOString(),
    summary: {
      totalTasks: tasks.length,
      runningTasks: tasks.filter((task) => task.status === "running").length,
      completedTasks: completed.length,
      failedTasks: tasks.filter((task) => task.status === "failed").length,
      cancelledTasks: tasks.filter((task) => task.status === "cancelled").length,
      participatingAgents,
      multiAgentRate: tasks.length === 0 ? 0 : multiAgentTasks / tasks.length,
      medianDurationMs: median(completed.map((task) => task.durationMs)),
    },
    trend: buildTrend(tasks, since, days),
    tasks,
  };
}

function buildConversationTasks(
  conversation: Conversation,
  messages: ChatMessage[],
  agentLabels: ReadonlyMap<AgentId, string>,
  now: Date,
): WorkTask[] {
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const rootCache = new Map<string, string>();
  const runsByRoot = new Map<string, ChatMessage[]>();

  for (const message of messages) {
    if (message.kind !== "agent" || !message.runId) continue;
    const rootId = findTaskRootId(message, messagesById, rootCache);
    runsByRoot.set(rootId, [...(runsByRoot.get(rootId) ?? []), message]);
  }

  const tasks: WorkTask[] = [];
  for (const [rootId, runs] of runsByRoot) {
    const root = messagesById.get(rootId);
    if (!root) continue;
    // When the user root is outside the in-window shard set, findTaskRootId
    // falls back to the highest in-window ancestor; anchor such a task on the
    // earliest in-window run instead of the (absent) root timestamp.
    const taskCreatedAt = root.kind === "user" ? root.createdAt : earliestRunCreatedAt(runs);
    const status = taskStatus(leafRuns(runs, messagesById));
    const completedAt = status === "running" ? undefined : runs.flatMap((run) => run.completedAt ?? []).sort().at(-1);
    const updatedAt = completedAt ?? latestRunActivity(runs) ?? taskCreatedAt;
    const agents = aggregateAgents(runs, agentLabels, now);
    const taskRuns = buildTaskRuns(runs, messagesById, agentLabels, taskCreatedAt, now);
    tasks.push({
      id: root.id,
      conversationId: conversation.id,
      conversationName: conversation.name,
      title: taskTitle(root.content),
      status,
      createdAt: taskCreatedAt,
      completedAt,
      updatedAt,
      durationMs: Math.max(0, Date.parse(completedAt ?? now.toISOString()) - Date.parse(taskCreatedAt)),
      agents,
      runs: taskRuns,
      hasParallelRuns: hasParallelRuns(taskRuns, now),
    });
  }
  return tasks;
}

/**
 * Resolve the id that anchors a task for a run: the originating user message if
 * it is within the loaded (in-window) message set, otherwise the highest
 * in-window ancestor. historySince() only reads shards overlapping the analysis
 * window, so a long task whose user root predates the window has its root
 * message absent here — falling back to the highest reachable ancestor keeps the
 * task visible (e.g. in the in-progress view) instead of dropping it, and
 * naturally groups a delegation chain rooted before the window into one task.
 */
function findTaskRootId(
  message: ChatMessage,
  messagesById: ReadonlyMap<string, ChatMessage>,
  cache: Map<string, string>,
): string {
  const cached = cache.get(message.id);
  if (cached !== undefined) return cached;
  const visited = new Set<string>();
  let current: ChatMessage | undefined = message;
  let fallback = message;
  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    if (current.kind === "user") {
      cache.set(message.id, current.id);
      return current.id;
    }
    fallback = current;
    current = current.parentMessageId ? messagesById.get(current.parentMessageId) : undefined;
  }
  cache.set(message.id, fallback.id);
  return fallback.id;
}

function taskStatus(runs: ChatMessage[]): WorkTaskStatus {
  if (runs.some((run) => run.runStatus === "running" || run.runStatus === "queued" || !run.completedAt)) return "running";
  if (runs.some((run) => run.runStatus === "failed")) return "failed";

  // Cancelling a queued run is branch-level cleanup and must not override work
  // that subsequently completed. A cancellation that actually started remains
  // an effective terminal outcome; the latest such outcome decides whether the
  // collaboration ended cancelled or recovered with a later completion.
  const terminalRuns = runs.filter((run) => run.completedAt);
  const effectiveRuns = terminalRuns.filter((run) => !(run.runStatus === "cancelled" && !run.startedAt));
  const outcomeRuns = effectiveRuns.length > 0 ? effectiveRuns : terminalRuns;
  const latestOutcome = [...outcomeRuns].sort((a, b) =>
    (a.completedAt ?? a.createdAt).localeCompare(b.completedAt ?? b.createdAt)
  ).at(-1);
  return latestOutcome?.runStatus === "cancelled" ? "cancelled" : "completed";
}

function leafRuns(runs: ChatMessage[], messagesById: ReadonlyMap<string, ChatMessage>): ChatMessage[] {
  const runIds = new Set(runs.map((run) => run.id));
  const parentRunIds = new Set<string>();
  for (const run of runs) {
    const visited = new Set<string>();
    let parent = run.parentMessageId ? messagesById.get(run.parentMessageId) : undefined;
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      if (runIds.has(parent.id)) {
        parentRunIds.add(parent.id);
        break;
      }
      parent = parent.parentMessageId ? messagesById.get(parent.parentMessageId) : undefined;
    }
  }
  return runs.filter((run) => !parentRunIds.has(run.id));
}

function aggregateAgents(runs: ChatMessage[], agentLabels: ReadonlyMap<AgentId, string>, now: Date): WorkTaskAgent[] {
  const byAgent = new Map<AgentId, ChatMessage[]>();
  for (const run of runs) {
    if (!run.agentId) continue;
    byAgent.set(run.agentId, [...(byAgent.get(run.agentId) ?? []), run]);
  }
  return Array.from(byAgent, ([agentId, agentRuns]) => ({
    agentId,
    label: agentLabels.get(agentId) ?? agentId,
    status: runStatus(agentRuns.at(-1)!),
    durationMs: agentRuns.reduce((total, run) => {
      const startedAt = run.startedAt ?? run.createdAt;
      return total + Math.max(0, Date.parse(run.completedAt ?? now.toISOString()) - Date.parse(startedAt));
    }, 0),
    runCount: agentRuns.length,
  })).sort((a, b) => {
    const firstA = runs.findIndex((run) => run.agentId === a.agentId);
    const firstB = runs.findIndex((run) => run.agentId === b.agentId);
    return firstA - firstB;
  });
}

function buildTaskRuns(
  runs: ChatMessage[],
  messagesById: ReadonlyMap<string, ChatMessage>,
  agentLabels: ReadonlyMap<AgentId, string>,
  taskCreatedAt: string,
  now: Date,
): WorkTaskRun[] {
  const runIds = new Set(runs.map((run) => run.id));
  return runs
    .filter((run): run is ChatMessage & { agentId: AgentId } => Boolean(run.agentId))
    .map((run) => {
      const startedAt = run.runStatus === "queued" ? run.startedAt : (run.startedAt ?? run.createdAt);
      return {
        id: run.id,
        agentId: run.agentId,
        label: agentLabels.get(run.agentId) ?? run.agentId,
        status: runStatus(run),
        startedAt,
        completedAt: run.completedAt,
        durationMs: startedAt ? Math.max(0, Date.parse(run.completedAt ?? now.toISOString()) - Date.parse(startedAt)) : 0,
        offsetMs: startedAt ? Math.max(0, Date.parse(startedAt) - Date.parse(taskCreatedAt)) : 0,
        parentRunId: findParentRunId(run, messagesById, runIds),
      };
    })
    .sort((a, b) => (a.startedAt ?? taskCreatedAt).localeCompare(b.startedAt ?? taskCreatedAt));
}

function findParentRunId(
  run: ChatMessage,
  messagesById: ReadonlyMap<string, ChatMessage>,
  runIds: ReadonlySet<string>,
): string | undefined {
  const visited = new Set<string>();
  let parent = run.parentMessageId ? messagesById.get(run.parentMessageId) : undefined;
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id);
    if (runIds.has(parent.id)) return parent.id;
    parent = parent.parentMessageId ? messagesById.get(parent.parentMessageId) : undefined;
  }
  return undefined;
}

function hasParallelRuns(runs: WorkTaskRun[], now: Date): boolean {
  const timedRuns = runs.filter((run) => run.startedAt && run.status !== "queued");
  return timedRuns.some((run, index) => timedRuns.slice(index + 1).some((other) => {
    if (run.agentId === other.agentId) return false;
    const start = Date.parse(run.startedAt!);
    const end = Date.parse(run.completedAt ?? now.toISOString());
    const otherStart = Date.parse(other.startedAt!);
    const otherEnd = Date.parse(other.completedAt ?? now.toISOString());
    return start < otherEnd && otherStart < end;
  }));
}

function runStatus(run: ChatMessage): WorkTaskRunStatus {
  if (run.runStatus === "queued") return "queued";
  if (run.runStatus === "running" || !run.completedAt) return "running";
  if (run.runStatus === "failed") return "failed";
  if (run.runStatus === "cancelled") return "cancelled";
  return "completed";
}

function latestRunActivity(runs: ChatMessage[]): string | undefined {
  return runs.flatMap((run) => run.completedAt ?? run.startedAt ?? run.createdAt).sort().at(-1);
}

function earliestRunCreatedAt(runs: ChatMessage[]): string {
  return runs.map((run) => run.createdAt).sort().at(0) as string;
}

function taskTitle(content: string): string {
  // Reuse the canonical assignment marker pattern so titles stay in sync with
  // how @agent: mentions are parsed (including the fullwidth colon form).
  const title = content.replace(assignmentPattern, "").replace(/\s+/g, " ").trim();
  if (!title) return "未命名任务";
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function buildTrend(tasks: WorkTask[], since: Date, days: number): WorkAnalysis["trend"] {
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(since);
    day.setDate(since.getDate() + index);
    const date = localDateKey(day);
    const completed = tasks.filter((task) => task.status === "completed" && task.completedAt && localDateKey(new Date(task.completedAt)) === date);
    return {
      date,
      completedTasks: completed.length,
      medianDurationMs: median(completed.map((task) => task.durationMs)),
    };
  });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function startOfLocalDay(date: Date): Date {
  date.setHours(0, 0, 0, 0);
  return date;
}

function localDateKey(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
