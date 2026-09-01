import os from "node:os";

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
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
