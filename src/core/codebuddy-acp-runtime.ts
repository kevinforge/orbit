import os from "node:os";

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";

import {
  createAcpRuntime,
  decideAcpPermission,
  resolveAcpElicitation,
  resolveAcpPermission,
  runAcp,
  type AcpConnection,
  type AcpConnector,
  type AcpRunOptions,
  type AcpRuntimeDefinition,
  type AcpTurnState,
} from "./acp-runtime.ts";
import type { AgentRuntime, AgentRuntimeRunHandle } from "./agent-runtime.ts";
import type { AgentActivityEvent, AgentPlanEntry } from "../shared/types.ts";

export type CodeBuddyAcpRunOptions = AcpRunOptions;
export type CodeBuddyAcpConnection = AcpConnection;
export type CodeBuddyAcpConnector = AcpConnector;

export function buildCodeBuddyAcpArgs(): string[] {
  return ["--acp"];
}

export function buildCodeBuddyAcpCommand(): { file: string; args: string[] } {
  const args = buildCodeBuddyAcpArgs();
  if (os.platform() !== "win32") {
    return { file: "codebuddy", args };
  }

  return { file: "cmd.exe", args: ["/d", "/s", "/c", "codebuddy.cmd", ...args] };
}

export function classifyCodeBuddyAnswerChunk(
  update: Parameters<NonNullable<AcpRuntimeDefinition["classifyAnswerChunk"]>>[0],
): ReturnType<NonNullable<AcpRuntimeDefinition["classifyAnswerChunk"]>> {
  const meta = update._meta;
  if (!meta || typeof meta !== "object") return undefined;
  if (meta["codebuddy.ai/isCompactInternal"] === true) return "ignore";
  if (meta["codebuddy.ai/memberEvent"] !== undefined) return "progress";
  return undefined;
}

/**
 * CodeBuddy 的历史回放标记（issue #172）。
 *
 * CodeBuddy 在 `session/new`（用 `setTimeout` 异步发出的初始帧）与 `session/load`
 * 之后会把历史重新推一遍：回放区间由 `session_info_update._meta
 * ["codebuddy.ai/historyReplay"]` 的 `start`/`end` 界定，区间内的每一帧还带
 * `_meta["codebuddy.ai"] = { mode: "history", offset }`；同一份 meta 同时写在
 * update 与通知两级。正因为它是异步发出的，回放可能落在当前轮首个模型边界
 * 之前或之后，所以按显式标记整帧丢弃，而不是按到达顺序推断。
 *
 * 两级 `_meta` 都检查：内容帧的标记在 update 上，通知级是镜像，多认一处不会
 * 误伤（只有帧自称 history 时才丢弃）。区间状态兜住不带逐帧标记的帧；观察到
 * 本轮首个模型相位时也会收口，避免回放缺少 `end` 时把整轮吞掉。
 */
export function isCodeBuddyReplayFrame(
  notification: Parameters<NonNullable<AcpRuntimeDefinition["isReplayedUpdate"]>>[0],
  turn: AcpTurnState,
): boolean {
  const update = notification.update;
  const boundary = historyReplayBoundary(update._meta) ?? historyReplayBoundary(notification._meta);
  if (boundary === "start") {
    turn.inHistoryReplay = true;
    return true;
  }
  if (boundary === "end") {
    turn.inHistoryReplay = false;
    return true;
  }
  if (turn.inHistoryReplay) {
    // 回放缺少 `end` 标记时用本轮首个模型相位收口：回放只重放历史条目，不带
    // agentPhase，所以带模型相位的帧一定是本轮真正开始，不能因窗口开着就丢掉。
    if (isCodeBuddyModelPhase(update)) {
      turn.inHistoryReplay = false;
      return false;
    }
    return true;
  }
  return codeBuddyMetaMode(update._meta) === "history" || codeBuddyMetaMode(notification._meta) === "history";
}

function isCodeBuddyModelPhase(update: SessionNotification["update"]): boolean {
  if (update.sessionUpdate !== "session_info_update") return false;
  const phase = readCodeBuddyAgentPhase(update._meta);
  return phase === "model_requesting" || phase === "model_streaming";
}

function historyReplayBoundary(meta: unknown): "start" | "end" | undefined {
  const value = readCodeBuddyMetaValue(meta, "codebuddy.ai/historyReplay");
  return value === "start" || value === "end" ? value : undefined;
}

/** `_meta["codebuddy.ai"].mode`；回放帧为 "history"。 */
function codeBuddyMetaMode(meta: unknown): string | undefined {
  const nested = readCodeBuddyMetaValue(meta, "codebuddy.ai");
  if (!nested || typeof nested !== "object") return undefined;
  const mode = (nested as Record<string, unknown>).mode;
  return typeof mode === "string" && mode ? mode : undefined;
}

function readCodeBuddyMetaValue(meta: unknown, key: string): unknown {
  if (!meta || typeof meta !== "object") return undefined;
  return (meta as Record<string, unknown>)[key];
}

/**
 * CodeBuddy 在一个回合内复用同一个顶层 messageId（`{sessionId}-{requestId}`），
 * 过程叙述与最终答案无法靠 messageId 区分。`session_info_update._meta
 * ["codebuddy.ai/agentPhase"]` 上的模型响应相位（preparing → model_requesting →
 * model_streaming → model_done → tool_executing → …）是唯一可靠的响应边界信号：
 * 每进入一次 model_requesting/model_streaming 就递增响应序号，answer 分片按
 * 响应序号分组，"最后一个有内容的组"即最终答案，之前的组归入过程文本。
 * 若相位信号缺失（旧版本），序号保持 0，退回单组行为，不会丢文本。
 */
export function observeCodeBuddySessionUpdate(
  update: Parameters<NonNullable<AcpRuntimeDefinition["observeSessionUpdate"]>>[0],
  turn: AcpTurnState,
): void {
  if (update.sessionUpdate !== "session_info_update") return;
  const phase = readCodeBuddyAgentPhase(update._meta);
  const inModelResponse = phase === "model_requesting" || phase === "model_streaming";
  if (inModelResponse && !turn.inModelResponse) {
    turn.inModelResponse = true;
    turn.modelResponseIndex += 1;
  } else if (!inModelResponse) {
    turn.inModelResponse = false;
  }
}

function readCodeBuddyAgentPhase(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const value = (meta as Record<string, unknown>)["codebuddy.ai/agentPhase"];
  if (typeof value === "string") return value || undefined;
  if (!value || typeof value !== "object") return undefined;
  const phase = (value as Record<string, unknown>).phase;
  return typeof phase === "string" && phase ? phase : undefined;
}

export function codeBuddyAnswerGroupKey(
  update: Parameters<NonNullable<AcpRuntimeDefinition["answerGroupKey"]>>[0],
  turn: AcpTurnState,
): string {
  return `codebuddy-response-${turn.modelResponseIndex}`;
}

/** CodeBuddy Task 工具投影出的计划快照固定 id（issue #161）。 */
export const CODEBUDDY_TASKS_PLAN_ID = "codebuddy-tasks";

/**
 * 把 TaskCreate/TaskUpdate 成功完成事件投影为完整计划快照（issue #161）。
 * CodeBuddy 在这类完成事件的 `_meta["codebuddy.ai/rawResponse"].todos` 中携带
 * 操作后的完整任务列表，删除亦不例外，因此投影始终整体替换、无需猜测状态：
 * - pending/in_progress/completed 原样映射；deleted 条目视为已删除，从快照消失；
 * - in_progress 内容优先 activeForm，缺失或空白时回退 content；
 * - 任务没有优先级概念，固定映射为 medium（显式 high/low 保留）；
 * - plan.id 固定为 "codebuddy-tasks"。
 * 严格校验：todos 缺失、非数组或元素结构不完整时返回 undefined，保留运行中
 * 已有计划，绝不因扩展字段畸形清空计划或让运行失败。非 Task 工具、未完成的
 * 工具帧（共享层只在成功完成时调用本钩子）一律不投影。
 */
export function projectCodeBuddyToolCompletion(
  update: Parameters<NonNullable<AcpRuntimeDefinition["projectToolCompletion"]>>[0],
): AgentActivityEvent | undefined {
  const toolName = readCodeBuddyMetaString(update._meta, "codebuddy.ai/toolName");
  if (toolName !== "TaskCreate" && toolName !== "TaskUpdate") return undefined;
  const entries = toCodeBuddyPlanEntries(readCodeBuddyRawTodos(update._meta));
  if (!entries) return undefined;
  return {
    type: "plan.updated",
    plan: { id: CODEBUDDY_TASKS_PLAN_ID, format: "items", entries },
    timestamp: new Date().toISOString(),
  };
}

function readCodeBuddyMetaString(meta: unknown, key: string): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readCodeBuddyRawTodos(meta: unknown): readonly unknown[] | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const rawResponse = (meta as Record<string, unknown>)["codebuddy.ai/rawResponse"];
  if (!rawResponse || typeof rawResponse !== "object") return undefined;
  const todos = (rawResponse as Record<string, unknown>).todos;
  return Array.isArray(todos) ? todos : undefined;
}

function toCodeBuddyPlanEntries(todos: readonly unknown[] | undefined): AgentPlanEntry[] | undefined {
  if (!todos) return undefined;
  const entries: AgentPlanEntry[] = [];
  for (const todo of todos) {
    if (!todo || typeof todo !== "object") return undefined;
    const { content, activeForm, priority, status } = todo as Record<string, unknown>;
    if (status === "deleted") continue;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return undefined;
    if (typeof content !== "string" || !content.trim()) return undefined;
    entries.push({
      content:
        status === "in_progress" && typeof activeForm === "string" && activeForm.trim()
          ? activeForm
          : content,
      priority: priority === "high" || priority === "low" ? priority : "medium",
      status,
    });
  }
  return entries;
}

export const CODEBUDDY_ACP: AcpRuntimeDefinition = {
  kind: "codebuddy",
  displayName: "CodeBuddy",
  buildCommand: buildCodeBuddyAcpCommand,
  agentIdEnvNames: ["CODEBUDDY_AGENT_ID"],
  toolNameMetaKeys: ["codebuddy.ai/toolName"],
  classifyAnswerChunk: classifyCodeBuddyAnswerChunk,
  observeSessionUpdate: observeCodeBuddySessionUpdate,
  answerGroupKey: codeBuddyAnswerGroupKey,
  guardPooledSessionReplay: true,
  isReplayedUpdate: isCodeBuddyReplayFrame,
  projectToolCompletion: projectCodeBuddyToolCompletion,
};

export function createCodeBuddyAcpRuntime(
  connector?: CodeBuddyAcpConnector,
): AgentRuntime {
  return createAcpRuntime(CODEBUDDY_ACP, connector);
}

export function runCodeBuddyAcp(
  options: CodeBuddyAcpRunOptions,
  connector?: CodeBuddyAcpConnector,
): AgentRuntimeRunHandle {
  return runAcp(options, CODEBUDDY_ACP, connector);
}

export function decideCodeBuddyPermission(
  request: RequestPermissionRequest,
): RequestPermissionResponse {
  return decideAcpPermission(request);
}

export function resolveCodeBuddyPermission(
  request: RequestPermissionRequest,
  options: CodeBuddyAcpRunOptions,
): Promise<RequestPermissionResponse> {
  return resolveAcpPermission(request, options, CODEBUDDY_ACP);
}

export function resolveCodeBuddyElicitation(
  request: CreateElicitationRequest,
  options: CodeBuddyAcpRunOptions,
): Promise<CreateElicitationResponse> {
  return resolveAcpElicitation(request, options);
}

export const codeBuddyRuntime = createCodeBuddyAcpRuntime();
