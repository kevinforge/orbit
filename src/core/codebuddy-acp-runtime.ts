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

export const CODEBUDDY_ACP: AcpRuntimeDefinition = {
  kind: "codebuddy",
  displayName: "CodeBuddy",
  buildCommand: buildCodeBuddyAcpCommand,
  agentIdEnvNames: ["CODEBUDDY_AGENT_ID"],
  toolNameMetaKeys: ["codebuddy.ai/toolName"],
  classifyAnswerChunk: classifyCodeBuddyAnswerChunk,
  observeSessionUpdate: observeCodeBuddySessionUpdate,
  answerGroupKey: codeBuddyAnswerGroupKey,
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
