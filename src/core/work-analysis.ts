import type { AgentId, ChatMessage, Conversation, WorkAnalysis, WorkTask, WorkTaskAgent, WorkTaskStatus } from "../shared/types.ts";

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

export function buildWorkAnalysis(options: BuildWorkAnalysisOptions): WorkAnalysis {
  const now = options.now ?? new Date();
  const days = Math.max(1, Math.floor(options.days));
  const since = startOfLocalDay(new Date(now.getTime()));
  since.setDate(since.getDate() - (days - 1));
  const tasks = options.conversations
    .flatMap(({ conversation, messages }) => buildConversationTasks(conversation, messages, options.agentLabels))
    .filter((task) => Date.parse(task.completedAt) >= since.getTime() && Date.parse(task.completedAt) <= now.getTime())
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));

  const completed = tasks.filter((task) => task.status === "completed");
  const participatingAgents = new Set(tasks.flatMap((task) => task.agents.map((agent) => agent.agentId))).size;
  const multiAgentTasks = tasks.filter((task) => task.agents.length >= 2).length;

  return {
    workspaceId: options.workspaceId,
    days,
    generatedAt: now.toISOString(),
    summary: {
      totalTasks: tasks.length,
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
): WorkTask[] {
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const rootCache = new Map<string, string | null>();
  const runsByRoot = new Map<string, ChatMessage[]>();

  for (const message of messages) {
    if (message.kind !== "agent" || !message.runId) continue;
    const rootId = findRootUserMessageId(message, messagesById, rootCache);
    if (!rootId) continue;
    runsByRoot.set(rootId, [...(runsByRoot.get(rootId) ?? []), message]);
  }

  const tasks: WorkTask[] = [];
  for (const [rootId, runs] of runsByRoot) {
    if (runs.some((run) => run.runStatus === "running" || run.runStatus === "queued" || !run.completedAt)) continue;
    const root = messagesById.get(rootId);
    if (!root) continue;
    const status = taskStatus(leafRuns(runs, messagesById));
    const completedAt = runs.map((run) => run.completedAt!).sort().at(-1)!;
    const agents = aggregateAgents(runs, agentLabels);
    tasks.push({
      id: root.id,
      conversationId: conversation.id,
      conversationName: conversation.name,
      title: taskTitle(root.content),
      status,
      createdAt: root.createdAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(root.createdAt)),
      agents,
    });
  }
  return tasks;
}

function findRootUserMessageId(
  message: ChatMessage,
  messagesById: ReadonlyMap<string, ChatMessage>,
  cache: Map<string, string | null>,
): string | null {
  if (cache.has(message.id)) return cache.get(message.id) ?? null;
  const visited = new Set<string>();
  let current: ChatMessage | undefined = message;
  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    if (current.kind === "user") {
      cache.set(message.id, current.id);
      return current.id;
    }
    current = current.parentMessageId ? messagesById.get(current.parentMessageId) : undefined;
  }
  cache.set(message.id, null);
  return null;
}

function taskStatus(runs: ChatMessage[]): WorkTaskStatus {
  if (runs.some((run) => run.runStatus === "failed")) return "failed";
  if (runs.some((run) => run.runStatus === "cancelled")) return "cancelled";
  return "completed";
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

function aggregateAgents(runs: ChatMessage[], agentLabels: ReadonlyMap<AgentId, string>): WorkTaskAgent[] {
  const byAgent = new Map<AgentId, ChatMessage[]>();
  for (const run of runs) {
    if (!run.agentId) continue;
    byAgent.set(run.agentId, [...(byAgent.get(run.agentId) ?? []), run]);
  }
  return Array.from(byAgent, ([agentId, agentRuns]) => ({
    agentId,
    label: agentLabels.get(agentId) ?? agentId,
    status: taskStatus([agentRuns.at(-1)!]),
    durationMs: agentRuns.reduce((total, run) => {
      const startedAt = run.startedAt ?? run.createdAt;
      return total + Math.max(0, Date.parse(run.completedAt!) - Date.parse(startedAt));
    }, 0),
    runCount: agentRuns.length,
  })).sort((a, b) => {
    const firstA = runs.findIndex((run) => run.agentId === a.agentId);
    const firstB = runs.findIndex((run) => run.agentId === b.agentId);
    return firstA - firstB;
  });
}

function taskTitle(content: string): string {
  const title = content.replace(/@[a-z0-9_-]+\s*:/gi, "").replace(/\s+/g, " ").trim();
  if (!title) return "未命名任务";
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function buildTrend(tasks: WorkTask[], since: Date, days: number): WorkAnalysis["trend"] {
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(since);
    day.setDate(since.getDate() + index);
    const date = localDateKey(day);
    const completed = tasks.filter((task) => task.status === "completed" && localDateKey(new Date(task.completedAt)) === date);
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
