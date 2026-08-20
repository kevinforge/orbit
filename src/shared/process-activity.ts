import type { AgentActivityEvent, PersistedProcessTimelineEntry } from "./types.ts";

export type ProcessToolActivity = Extract<AgentActivityEvent, {
  type: "tool.started" | "tool.completed" | "tool.failed" | "error";
}>;

export type ProcessToolExecution = {
  key: string;
  name: string;
  status: "running" | "completed" | "failed";
  input?: string;
  summary?: string;
  timestamp: string;
};

/**
 * Applies one live process event while preserving the ACP event order.
 * Settlement snapshots remove only the answer group selected as the final reply,
 * leaving progress narration and tool calls in their original positions.
 */
export function appendTransientProcessActivity(
  current: AgentActivityEvent[],
  activity: AgentActivityEvent,
): AgentActivityEvent[] {
  if (activity.type !== "process.text" || !activity.snapshot) {
    return [...current, activity];
  }

  if ("excludedAnswerGroup" in activity) {
    return current.filter((item) => !(
      item.type === "process.text"
      && item.stream === "answer"
      && item.answerGroup === activity.excludedAnswerGroup
    ));
  }

  // Compatibility for snapshot events created before ordered process metadata.
  const withoutProcessText = current.filter((item) => item.type !== "process.text");
  if (!activity.text) return withoutProcessText;
  return [...withoutProcessText, {
    ...activity,
    snapshot: false,
    stream: "progress",
  }];
}

export function collapseToolExecutions(activities: ProcessToolActivity[]): ProcessToolExecution[] {
  const executions: ProcessToolExecution[] = [];
  const byId = new Map<string, ProcessToolExecution>();

  activities.forEach((activity, index) => {
    if (activity.type === "error") {
      executions.push({
        key: `error-${index}`,
        name: "运行错误",
        status: "failed",
        summary: activity.message,
        timestamp: activity.timestamp,
      });
      return;
    }

    const id = activity.toolCallId;
    let execution = id ? byId.get(id) : undefined;
    if (!execution && activity.type !== "tool.started") {
      execution = [...executions].reverse().find((candidate) => (
        candidate.name === activity.name && candidate.status === "running"
      ));
    }

    if (!execution) {
      execution = {
        key: id ?? `tool-${index}`,
        name: activity.name,
        status: activity.type === "tool.failed" ? "failed" : activity.type === "tool.completed" ? "completed" : "running",
        ...(activity.type === "tool.started" && activity.input ? { input: activity.input } : {}),
        ...(activity.type !== "tool.started" && activity.summary ? { summary: activity.summary } : {}),
        timestamp: activity.timestamp,
      };
      executions.push(execution);
      if (id) byId.set(id, execution);
      return;
    }

    execution.name = activity.name || execution.name;
    execution.timestamp = activity.timestamp;
    if (activity.type === "tool.completed") execution.status = "completed";
    if (activity.type === "tool.failed") execution.status = "failed";
    if (activity.type === "tool.started" && activity.input) execution.input = activity.input;
    if (activity.type !== "tool.started" && activity.summary) execution.summary = activity.summary;
  });

  return executions;
}

/**
 * Converts the live activity stream into a compact durable projection. Text order
 * is retained, while each adjacent tool group stores counts only.
 */
export function buildPersistedProcessTimeline(
  activity: AgentActivityEvent[],
  maxTextChars = 20_000,
): PersistedProcessTimelineEntry[] {
  const timeline: Array<
    | PersistedProcessTimelineEntry
    | { type: "tool-events"; activities: ProcessToolActivity[] }
  > = [];
  let remainingTextChars = Math.max(0, maxTextChars);

  const appendText = (text: string): void => {
    if (!text || remainingTextChars <= 0) return;
    const clipped = text.length <= remainingTextChars
      ? text
      : `${text.slice(0, Math.max(0, remainingTextChars - 1))}…`;
    remainingTextChars -= clipped.length;
    const previous = timeline.at(-1);
    if (previous?.type === "text") {
      previous.text += clipped;
    } else {
      timeline.push({ type: "text", text: clipped });
    }
  };

  for (const item of activity) {
    if (item.type === "process.text") {
      appendText(item.text);
      continue;
    }
    if (item.type !== "tool.started" && item.type !== "tool.completed" && item.type !== "tool.failed" && item.type !== "error") {
      continue;
    }
    const previous = timeline.at(-1);
    if (previous?.type === "tool-events") {
      previous.activities.push(item);
    } else {
      timeline.push({ type: "tool-events", activities: [item] });
    }
  }

  return timeline.flatMap((entry): PersistedProcessTimelineEntry[] => {
    if (entry.type !== "tool-events") return [entry];
    const executions = collapseToolExecutions(entry.activities);
    if (executions.length === 0) return [];
    return [{
      type: "tools",
      count: executions.length,
      failedCount: executions.filter((execution) => execution.status === "failed").length,
    }];
  });
}
