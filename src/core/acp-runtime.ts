import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type AgentCapabilities,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ContentBlock,
  type ClientConnection,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type SessionNotification,
  type ToolCallStatus,
  type ToolKind,
} from "@agentclientprotocol/sdk";

import type {
  AgentActivityEvent,
  AgentElicitationRequest,
  AgentId,
  AgentRuntimeKind,
} from "../shared/types.ts";
import { AgentRunCancelledError, type AgentRuntime, type AgentRuntimeRunHandle, type AgentRuntimeRunOptions } from "./agent-runtime.ts";
import { interruptProcessTree } from "./process-tree.ts";
import { extractReadableText } from "./ansi-text-extractor.ts";
import {
  AcpStderrForwarder,
  createAcpFrameLimitTransform,
} from "./acp-output-guard.ts";
import { AcpConnectionPool } from "./acp-connection-pool.ts";

/**
 * 取消宽限期：interrupt 先发 session/cancel 优雅取消；超过该时限仍未结算的
 * 回合强制销毁连接并收口结果，避免运行永久停留在取消中（issue #136）。
 */
export const CANCEL_GRACE_MS = 10_000;

export type AcpRunOptions = AgentRuntimeRunOptions;

export type AcpConnection = {
  readonly pid: number;
  initialize(request: InitializeRequest): Promise<InitializeResponse>;
  newSession(request: NewSessionRequest): Promise<NewSessionResponse>;
  loadSession(request: LoadSessionRequest): Promise<void>;
  resumeSession(request: ResumeSessionRequest): Promise<void>;
  prompt(request: PromptRequest): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  hasSession?(sessionId: string): boolean;
  close(): void;
  destroy?(): void;
};

export type AcpReusableConnection = AcpConnection & {
  rebind(
    options: AcpRunOptions,
    onSessionUpdate: (notification: SessionNotification) => void,
  ): void;
  deactivate(): void;
  isAlive(): boolean;
};

export type AcpConnector = (
  options: AcpRunOptions,
  onSessionUpdate: (notification: SessionNotification) => void,
) => AcpConnection;

export type AcpCommand = {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

export type AcpAnswerChunkDisposition = "candidate" | "final" | "progress" | "ignore";

/**
 * 每回合共享的分类状态。部分 runtime（如 CodeBuddy）在一个回合内复用同一个
 * ACP messageId 输出多段模型响应，需要靠会话级信号（agentPhase）划分响应边界，
 * 用响应序号代替 messageId 作为 answer 分组键。
 */
export type AcpTurnState = {
  /** 当前分片所处的模型响应序号；runtime 通过 observeSessionUpdate 递增。 */
  modelResponseIndex: number;
  /** 是否处于一次模型响应中（用于去重递增，避免 requesting→streaming 重复计数）。 */
  inModelResponse: boolean;
};

export type AcpRuntimeDefinition = {
  kind: AgentRuntimeKind;
  displayName: string;
  buildCommand: (env?: NodeJS.ProcessEnv) => AcpCommand;
  agentIdEnvNames?: string[];
  toolNameMetaKeys?: string[];
  envForRun?: (options: AcpRunOptions) => NodeJS.ProcessEnv;
  isDiagnosticMessage?: (update: SessionNotification["update"]) => boolean;
  classifyAnswerChunk?: (update: SessionNotification["update"]) => AcpAnswerChunkDisposition | undefined;
  /** 观察所有会话级更新帧，维护 runtime 特定的回合状态（如 CodeBuddy agentPhase 响应边界）。 */
  observeSessionUpdate?: (update: SessionNotification["update"], turn: AcpTurnState) => void;
  /**
   * 解析 answer 分片的分组键；默认使用 ACP messageId。最终答案取"最后一个有内容的组"，
   * 其余组的文本在结算时归入过程文本（process.text 快照）。
   */
  answerGroupKey?: (update: SessionNotification["update"], turn: AcpTurnState) => string | undefined;
};

const acpConnectionPool = new AcpConnectionPool(spawnAcpConnection);

export function disposeAcpConnectionPool(): void {
  acpConnectionPool.dispose();
}

function pooledAcpConnector(
  definition: AcpRuntimeDefinition,
  options: AcpRunOptions,
  onSessionUpdate: (notification: SessionNotification) => void,
): AcpConnection {
  return acpConnectionPool.acquire(definition, options, onSessionUpdate);
}

type ToolState = {
  name: string;
  status?: ToolCallStatus | null;
};

type AnswerMessage = {
  candidateParts: string[];
  finalParts: string[];
};

type AnswerSegmentKind = "answer" | "progress";

/** 按到达顺序记录的文本分片，用于结算时生成"剔除最终回复正文后"的过程文本快照。 */
type AnswerSegment = {
  group: string;
  kind: AnswerSegmentKind;
  text: string;
};

type AnswerState = {
  messages: Map<string, AnswerMessage>;
  order: string[];
  unscopedCandidateParts: string[];
  unscopedFinalParts: string[];
  segments: AnswerSegment[];
};

export function createAcpRuntime(
  definition: AcpRuntimeDefinition,
  connector: AcpConnector = (options, onSessionUpdate) => pooledAcpConnector(definition, options, onSessionUpdate),
): AgentRuntime {
  return {
    kind: definition.kind,
    transport: "acp",
    protocolVersion: PROTOCOL_VERSION,
    run: (options) => runAcp(options, definition, connector),
  };
}

export function runAcp(
  options: AcpRunOptions,
  definition: AcpRuntimeDefinition,
  connector: AcpConnector = (runOptions, onSessionUpdate) => pooledAcpConnector(definition, runOptions, onSessionUpdate),
): AgentRuntimeRunHandle {
  let acceptingUpdates = false;
  let activeSessionId: string | null = null;
  let cancelled = false;
  let permissionRejected = false;
  let closed = false;
  let forcedCancelled = false;
  let cancelTimer: NodeJS.Timeout | null = null;
  const answerState = createAnswerState();
  const turnState = createTurnState();
  const toolStates = new Map<string, ToolState>();

  const connectorOptions: AcpRunOptions = {
    ...options,
    requestPermission: options.requestPermission
      ? async (request) => {
        const decision = await options.requestPermission!(request);
        if (decision === "reject") permissionRejected = true;
        return decision;
      }
      : undefined,
  };
  const connection = connector(connectorOptions, (notification) => {
    if (!acceptingUpdates || notification.sessionId !== activeSessionId) {
      return;
    }
    handleSessionUpdate(notification, answerState, turnState, toolStates, options, definition);
  });

  let resolveSessionId!: (sessionId: string | null) => void;
  let sessionIdSettled = false;
  const sessionId = new Promise<string | null>((resolve) => {
    resolveSessionId = (value) => {
      if (sessionIdSettled) return;
      sessionIdSettled = true;
      resolve(value);
    };
  });

  // 强制取消收口（issue #136）：runtime 无视 session/cancel 且底层 prompt 永不
  // 结算时，由该 Promise 结束 handle.result，运行不会永久停留在取消中。
  let rejectForcedCancel!: (error: AgentRunCancelledError) => void;
  const forcedCancellation = new Promise<never>((_resolve, reject) => {
    rejectForcedCancel = reject;
  });
  void forcedCancellation.catch(() => undefined);

  const close = (destroy = false) => {
    if (closed) return;
    closed = true;
    if (cancelTimer) clearTimeout(cancelTimer);
    if (destroy) connection.destroy?.();
    else connection.close();
  };

  const cancellationError = () => new AgentRunCancelledError(
    `${definition.displayName} ACP turn was cancelled.`,
    permissionRejected ? "权限申请未获批准，任务已停止。" : "运行已取消。",
  );

  /**
   * 强制收口：先落定 sessionId（AgentSession 的异常路径会 await 它，不能再次
   * 无限等待）、停止接受晚到的会话更新、销毁连接终止进程，最后让 handle.result
   * 以取消错误结束。
   */
  const forceCancel = (diagnostic: string) => {
    if (forcedCancelled || closed) return;
    forcedCancelled = true;
    cancelled = true;
    acceptingUpdates = false;
    if (cancelTimer) {
      clearTimeout(cancelTimer);
      cancelTimer = null;
    }
    resolveSessionId(activeSessionId);
    options.onOutput?.(`${definition.displayName} ${diagnostic}。`);
    close(true);
    rejectForcedCancel(new AgentRunCancelledError(
      `${definition.displayName} ACP turn was force-cancelled: ${diagnostic}`,
      permissionRejected ? "权限申请未获批准，任务已停止。" : "运行已取消。",
    ));
  };

  const turn = (async () => {
    let succeeded = false;
    try {
      const initialized = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          elicitation: {
            form: {},
            url: {},
          },
          plan: {},
        },
        clientInfo: { name: "Orbit", version: "1.0.0" },
      });
      validateInitializeResponse(initialized, definition.displayName);

      activeSessionId = await prepareSession(
        connection,
        initialized.agentCapabilities,
        options.cwd,
        options.resumeSessionId,
        definition.displayName,
      );
      resolveSessionId(activeSessionId);

      acceptingUpdates = !forcedCancelled;
      const response = await connection.prompt({
        sessionId: activeSessionId,
        prompt: buildPromptContent(options.prompt, options.imagePaths, initialized.agentCapabilities),
      });
      acceptingUpdates = false;

      if (cancelled || response.stopReason === "cancelled") {
        throw cancellationError();
      }
      if (response.stopReason === "refusal") {
        throw new Error(`${definition.displayName} ACP refused the request.`);
      }

      const selection = selectFinalAnswer(answerState);
      const answer = selection.text.trim();
      if (!answer) {
        throw new Error(`${definition.displayName} ACP completed with ${response.stopReason} but no final answer.`);
      }
      // 结算快照：流式期间所有文本（含将成为最终回复的文本）都以增量形式进入
      // 过程区；结算时剔除归入最终回复的分组文本，整体替换，保证不重复、不残留。
      emitProcessTextSnapshot(options, answerState, selection.group);
      succeeded = true;
      return answer;
    } catch (error: unknown) {
      // Cancellation can happen during initialize/session setup, before the
      // prompt response has a chance to report stopReason=cancelled.
      if (cancelled) throw cancellationError();
      throw error;
    } finally {
      acceptingUpdates = false;
      resolveSessionId(activeSessionId);
      close(!succeeded);
    }
  })();
  // 与正常回合竞速：强制收口时即使底层 prompt 永不结算，handle.result 也落定。
  const result: Promise<string> = Promise.race([turn, forcedCancellation]);

  const interrupt = () => {
    if (cancelled || closed) return;
    cancelled = true;
    if (!activeSessionId) {
      forceCancel("会话尚未建立，已强制终止进程");
      return;
    }

    // 先尝试优雅取消；请求失败或宽限期超时都立即强制收口。
    void connection.cancel(activeSessionId).catch(() => forceCancel("取消请求失败，已强制终止进程"));
    cancelTimer = setTimeout(
      () => forceCancel(`未在 ${CANCEL_GRACE_MS / 1000} 秒内响应取消，已强制终止进程`),
      CANCEL_GRACE_MS,
    );
    cancelTimer.unref?.();
  };

  return {
    process: {
      kill: close,
      pid: connection.pid,
      interrupt,
    },
    result,
    sessionId,
  };
}

async function prepareSession(
  connection: AcpConnection,
  capabilities: AgentCapabilities | undefined,
  cwd: string,
  existingSessionId?: string,
  displayName = "Agent",
): Promise<string> {
  const absoluteCwd = path.resolve(cwd);
  if (!existingSessionId) {
    const created = await connection.newSession({ cwd: absoluteCwd, mcpServers: [] });
    return created.sessionId;
  }

  if (connection.hasSession?.(existingSessionId)) {
    return existingSessionId;
  }

  const request = {
    sessionId: existingSessionId,
    cwd: absoluteCwd,
    mcpServers: [],
  };
  if (capabilities?.sessionCapabilities?.resume) {
    await connection.resumeSession(request satisfies ResumeSessionRequest);
    return existingSessionId;
  }
  if (capabilities?.loadSession) {
    await connection.loadSession(request);
    return existingSessionId;
  }

  throw new Error(
    `${displayName} ACP could not resume the session because the agent does not advertise session/load or session/resume.`,
  );
}

function validateInitializeResponse(response: InitializeResponse, displayName: string): void {
  if (response.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported ${displayName} ACP protocol version ${response.protocolVersion}; Orbit requires ${PROTOCOL_VERSION}.`,
    );
  }
}

function buildPromptContent(
  prompt: string,
  imagePaths: string[] | undefined,
  capabilities: AgentCapabilities | undefined,
): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: "text", text: prompt }];
  if (!imagePaths?.length) return blocks;

  if (!capabilities?.promptCapabilities?.image) {
    blocks.push({
      type: "text",
      text: `\nAttached image paths:\n${imagePaths.map((imagePath) => `- ${imagePath}`).join("\n")}`,
    });
    return blocks;
  }

  for (const imagePath of imagePaths) {
    blocks.push({
      type: "image",
      data: fs.readFileSync(imagePath).toString("base64"),
      mimeType: imageMimeType(imagePath),
      uri: pathToFileUri(imagePath),
    });
  }
  return blocks;
}

function imageMimeType(imagePath: string): string {
  switch (path.extname(imagePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function pathToFileUri(filePath: string): string {
  const normalized = path.resolve(filePath).replaceAll("\\", "/");
  return `file://${normalized.startsWith("/") ? "" : "/"}${encodeURI(normalized)}`;
}

function handleSessionUpdate(
  notification: SessionNotification,
  answerState: AnswerState,
  turnState: AcpTurnState,
  toolStates: Map<string, ToolState>,
  options: AcpRunOptions,
  definition: AcpRuntimeDefinition,
): void {
  const update = notification.update;
  definition.observeSessionUpdate?.(update, turnState);
  if (update.sessionUpdate === "plan") {
    emitActivity(options, {
      type: "plan.updated",
      plan: { format: "items", entries: update.entries.map(toAgentPlanEntry) },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (update.sessionUpdate === "plan_update") {
    const plan = update.plan;
    if (plan.type === "items") {
      emitActivity(options, {
        type: "plan.updated",
        plan: { id: plan.planId, format: "items", entries: plan.entries.map(toAgentPlanEntry) },
        timestamp: new Date().toISOString(),
      });
    } else if (plan.type === "markdown") {
      emitActivity(options, {
        type: "plan.updated",
        plan: { id: plan.planId, format: "markdown", content: plan.content },
        timestamp: new Date().toISOString(),
      });
    } else {
      emitActivity(options, {
        type: "plan.updated",
        plan: { id: plan.planId, format: "file", uri: plan.uri },
        timestamp: new Date().toISOString(),
      });
    }
    return;
  }

  if (update.sessionUpdate === "plan_removed") {
    emitActivity(options, {
      type: "plan.removed",
      planId: update.planId,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (update.sessionUpdate === "agent_message_chunk") {
    if (update.content.type === "text") {
      if (definition.isDiagnosticMessage?.(update)) {
        const text = update.content.text.trim();
        if (text) {
          options.onOutput?.(update.content.text);
          emitActivity(options, {
            type: "status",
            text,
            timestamp: new Date().toISOString(),
          });
        }
        return;
      }

      const disposition = definition.classifyAnswerChunk?.(update) ?? "candidate";
      if (disposition === "ignore") return;

      options.onOutput?.(update.content.text);
      if (disposition === "progress") {
        // 明确的过程叙述：不进入最终答案候选，直接作为过程文本流式输出。
        recordSegment(answerState, { group: "", kind: "progress", text: update.content.text });
        emitProcessText(options, update.content.text, "progress", "");
        return;
      }

      const answerGroup = appendAnswerChunk(answerState, update, disposition, update.content.text, definition, turnState);
      // 流式期间当前分组的文本同样进入过程区实时展示；结算快照会剔除
      // 归入最终回复的部分。
      emitProcessText(options, update.content.text, "answer", answerGroup);
    }
    return;
  }

  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return;
  }

  const previous = toolStates.get(update.toolCallId);
  const name = update.name ?? update.title ?? previous?.name ?? update.kind ?? "tool";
  const status = update.status ?? previous?.status;
  toolStates.set(update.toolCallId, { name, status });

  if (!previous && status !== "completed" && status !== "failed") {
    emitActivity(options, {
      type: "tool.started",
      toolCallId: update.toolCallId,
      name,
      ...(update.rawInput === undefined ? {} : { input: formatValue(update.rawInput) }),
      timestamp: new Date().toISOString(),
    });
  }
  if (status === "completed" && previous?.status !== "completed") {
    emitActivity(options, {
      type: "tool.completed",
      toolCallId: update.toolCallId,
      name,
      ...(update.rawOutput === undefined ? {} : { summary: formatValue(update.rawOutput) }),
      timestamp: new Date().toISOString(),
    });
  }
  if (status === "failed" && previous?.status !== "failed") {
    emitActivity(options, {
      type: "tool.failed",
      toolCallId: update.toolCallId,
      name,
      ...(update.rawOutput === undefined ? {} : { summary: formatValue(update.rawOutput) }),
      timestamp: new Date().toISOString(),
    });
  }
}

function toAgentPlanEntry(entry: {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}) {
  return {
    content: entry.content,
    priority: entry.priority,
    status: entry.status,
  };
}

function createAnswerState(): AnswerState {
  return {
    messages: new Map(),
    order: [],
    unscopedCandidateParts: [],
    unscopedFinalParts: [],
    segments: [],
  };
}

function createTurnState(): AcpTurnState {
  return { modelResponseIndex: 0, inModelResponse: false };
}

function recordSegment(state: AnswerState, segment: AnswerSegment): void {
  state.segments.push(segment);
}

function appendAnswerChunk(
  state: AnswerState,
  update: SessionNotification["update"],
  disposition: "candidate" | "final",
  text: string,
  definition: AcpRuntimeDefinition,
  turnState: AcpTurnState,
): string {
  const group = definition.answerGroupKey?.(update, turnState) ?? getAgentMessageId(update) ?? "";
  recordSegment(state, { group, kind: "answer", text });
  if (!group) {
    const parts = disposition === "final" ? state.unscopedFinalParts : state.unscopedCandidateParts;
    parts.push(text);
    return group;
  }

  let message = state.messages.get(group);
  if (!message) {
    message = { candidateParts: [], finalParts: [] };
    state.messages.set(group, message);
    state.order.push(group);
  }
  if (disposition === "final") {
    if (message.candidateParts.length) {
      message.finalParts.push(...message.candidateParts);
      message.candidateParts.length = 0;
    }
    message.finalParts.push(text);
    return group;
  }

  const parts = message.finalParts.length ? message.finalParts : message.candidateParts;
  parts.push(text);
  return group;
}

function getAgentMessageId(update: SessionNotification["update"]): string | undefined {
  if ("messageId" in update && typeof update.messageId === "string" && update.messageId) {
    return update.messageId;
  }

  const meta = update._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const flatMessageId = meta["codebuddy.ai/messageId"];
  if (typeof flatMessageId === "string" && flatMessageId) return flatMessageId;

  const codeBuddyMeta = meta["codebuddy.ai"];
  if (!codeBuddyMeta || typeof codeBuddyMeta !== "object") return undefined;
  const nestedMessageId = (codeBuddyMeta as Record<string, unknown>).messageId;
  return typeof nestedMessageId === "string" && nestedMessageId ? nestedMessageId : undefined;
}

function selectFinalAnswer(state: AnswerState): { text: string; group: string } {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const group = state.order[index]!;
    const message = state.messages.get(group);
    if (message?.finalParts.length) return { text: message.finalParts.join(""), group };
  }
  if (state.unscopedFinalParts.length) return { text: state.unscopedFinalParts.join(""), group: "" };

  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const group = state.order[index]!;
    const message = state.messages.get(group);
    if (message?.candidateParts.length) return { text: message.candidateParts.join(""), group };
  }
  return { text: state.unscopedCandidateParts.join(""), group: "" };
}

function emitProcessText(
  options: AcpRunOptions,
  text: string,
  stream: "progress" | "answer",
  answerGroup: string,
): void {
  if (!text) return;
  emitActivity(options, {
    type: "process.text",
    text,
    stream,
    answerGroup,
    timestamp: new Date().toISOString(),
  });
}

function emitProcessTextSnapshot(options: AcpRunOptions, state: AnswerState, finalGroup: string): void {
  if (state.segments.length === 0) return;
  const text = state.segments
    .filter((segment) => !(segment.kind === "answer" && segment.group === finalGroup))
    .map((segment) => segment.text)
    .join("");
  emitActivity(options, {
    type: "process.text",
    text,
    snapshot: true,
    excludedAnswerGroup: finalGroup,
    timestamp: new Date().toISOString(),
  });
}

function emitActivity(options: AcpRunOptions, activity: AgentActivityEvent): void {
  options.onActivity?.(activity);
}

function formatValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

export function decideAcpPermission(
  request: RequestPermissionRequest,
): RequestPermissionResponse {
  return selectAcpPermission(request, "allow");
}

export async function resolveAcpPermission(
  request: RequestPermissionRequest,
  options: AcpRunOptions,
  definition: AcpRuntimeDefinition,
): Promise<RequestPermissionResponse> {
  const toolName = acpToolName(request, definition.toolNameMetaKeys);
  const kind = resolvePermissionKind(request, toolName);
  if (options.approvalMode !== "full-access") {
    if (!options.requestPermission) return selectAcpPermission(request, "reject");
    const decision = await options.requestPermission({
      id: request.toolCall.toolCallId,
      title: request.toolCall.title || toolName || toolKindLabel(kind),
      ...(kind ? { kind } : {}),
      ...(request.toolCall.rawInput === undefined ? {} : { input: formatValue(request.toolCall.rawInput) }),
      ...(request.toolCall.locations?.length
        ? { locations: request.toolCall.locations.map((location) => location.path) }
        : {}),
    });
    return selectAcpPermission(request, decision);
  }

  return decideAcpPermission(request);
}

export async function resolveAcpElicitation(
  request: CreateElicitationRequest,
  options: AcpRunOptions,
): Promise<CreateElicitationResponse> {
  if (!options.requestElicitation) {
    return { action: "cancel" };
  }

  return options.requestElicitation(toAgentElicitationRequest(request));
}

function toAgentElicitationRequest(request: CreateElicitationRequest): AgentElicitationRequest {
  const raw = request as unknown as Record<string, unknown>;
  return {
    message: request.message,
    mode: request.mode,
    ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.requestId === "string" || typeof raw.requestId === "number" ? { id: String(raw.requestId) } : {}),
    ...(typeof raw.toolCallId === "string" ? { toolCallId: raw.toolCallId } : {}),
    ...(request.mode === "form" && raw.requestedSchema && typeof raw.requestedSchema === "object"
      ? { requestedSchema: raw.requestedSchema as AgentElicitationRequest["requestedSchema"] }
      : {}),
    ...(request.mode === "url" && typeof raw.elicitationId === "string" && typeof raw.url === "string"
      ? { elicitationId: raw.elicitationId, url: raw.url }
      : {}),
  };
}

function selectAcpPermission(
  request: RequestPermissionRequest,
  decision: "allow" | "reject",
): RequestPermissionResponse {
  const selectedKind = decision === "allow" ? "allow_once" : "reject_once";
  const selected = request.options.find((option) => option.kind === selectedKind);
  return selected
    ? { outcome: { outcome: "selected", optionId: selected.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

type PermissionKind = ToolKind | "write";

function acpToolName(
  request: RequestPermissionRequest,
  metaKeys: readonly string[] | undefined,
): string | undefined {
  for (const key of metaKeys ?? []) {
    const value = request.toolCall._meta?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function resolvePermissionKind(
  request: RequestPermissionRequest,
  toolName: string | undefined,
): PermissionKind | undefined {
  if (request.toolCall.kind && request.toolCall.kind !== "other") return request.toolCall.kind;
  const normalized = toolName?.toLowerCase().replace(/[\s_/-]+/g, "");
  switch (normalized) {
    case "read":
    case "readfile":
      return "read";
    case "glob":
    case "grep":
    case "search":
    case "find":
    case "ls":
      return "search";
    case "webfetch":
    case "websearch":
      return "fetch";
    case "write":
    case "writefile":
      return "write";
    case "edit":
    case "notebookedit":
    case "applypatch":
    case "multiedit":
      return "edit";
    case "delete":
    case "remove":
      return "delete";
    case "move":
    case "rename":
      return "move";
    case "bash":
    case "shell":
    case "execute":
    case "terminal":
    case "runcommand":
      return "execute";
    case "askuserquestion":
    case "todowrite":
      return "think";
    case "exitplanmode":
      return "switch_mode";
    default:
      return request.toolCall.kind ?? undefined;
  }
}

function toolKindLabel(kind: PermissionKind | null | undefined): string {
  switch (kind) {
    case "read": return "读取文件";
    case "search": return "搜索文件";
    case "fetch": return "访问网络";
    case "write": return "写入文件";
    case "edit": return "编辑文件";
    case "delete": return "删除文件";
    case "move": return "移动文件";
    case "execute": return "执行命令";
    default: return "执行操作";
  }
}

export function spawnAcpConnection(
  definition: AcpRuntimeDefinition,
  options: AcpRunOptions,
  onSessionUpdate: (notification: SessionNotification) => void,
): AcpReusableConnection {
  const baseEnv = options.env ?? process.env;
  const command = definition.buildCommand(baseEnv);
  const child = spawn(command.file, command.args, {
    cwd: options.cwd,
    env: createEnv(definition, options.agentId, {
      ...baseEnv,
      ...definition.envForRun?.(options),
      ...command.env,
    }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: os.platform() !== "win32",
  });
  let context: { options: AcpRunOptions; onSessionUpdate: typeof onSessionUpdate } | null = {
    options,
    onSessionUpdate,
  };
  const stderrForwarder = new AcpStderrForwarder();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const readable = extractReadableText(chunk);
    if (!readable) return;
    for (const output of stderrForwarder.forward(readable)) {
      context?.options.onOutput?.(output);
    }
  });

  const app = client({ name: "Orbit" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => (
      context ? resolveAcpPermission(params, context.options, definition) : selectAcpPermission(params, "reject")
    ))
    .onRequest(methods.client.elicitation.create, ({ params }) => (
      context ? resolveAcpElicitation(params, context.options) : Promise.resolve({ action: "cancel" })
    ))
    .onNotification(methods.client.elicitation.complete, ({ params }) => {
      context?.options.onActivity?.({
        type: "status",
        text: `外部输入流程已完成：${params.elicitationId}`,
        timestamp: new Date().toISOString(),
      });
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      context?.onSessionUpdate(params);
    });
  const guardedStdout = child.stdout.pipe(createAcpFrameLimitTransform());
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(guardedStdout) as ReadableStream<Uint8Array>,
  );
  const acp = app.connect(stream);

  const connection = connectionFromProcess(child, acp, definition.displayName, guardedStdout, () => stderrForwarder.tailText());
  return {
    ...connection,
    rebind(nextOptions, nextOnSessionUpdate) {
      context = { options: nextOptions, onSessionUpdate: nextOnSessionUpdate };
      stderrForwarder.reset();
    },
    deactivate() {
      context = null;
    },
    isAlive() {
      return child.exitCode === null && child.signalCode === null;
    },
  };
}

function connectionFromProcess(
  child: ChildProcessWithoutNullStreams,
  acp: ClientConnection,
  displayName: string,
  guardedStdout?: NodeJS.ReadableStream,
  stderrText?: () => string,
): AcpConnection {
  const pid = child.pid ?? 0;
  let closed = false;
  let rejectProcessFailure!: (error: Error) => void;
  const processFailure = new Promise<never>((_resolve, reject) => {
    rejectProcessFailure = reject;
  });
  void processFailure.catch(() => undefined);
  child.once("error", (error) => rejectProcessFailure(error));
  guardedStdout?.once("error", (error) => rejectProcessFailure(error));
  child.once("exit", (code, signal) => {
    if (!closed) {
      const stderr = stderrText?.().trim();
      rejectProcessFailure(new Error(
        `${displayName} ACP process exited unexpectedly (${code === null ? signal : `code ${code}`}).` +
        (stderr ? `\n${stderr}` : ""),
      ));
    }
  });
  const request = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, processFailure]);

  const terminate = () => {
    if (closed) return;
    closed = true;
    const processStillRunning = child.exitCode === null && child.signalCode === null;
    if (pid > 0 && processStillRunning) {
      if (os.platform() === "win32") {
        // Finish tree termination before closing stdio. If cmd.exe exits first,
        // taskkill can no longer discover and terminate the nested agent process.
        spawnSync("taskkill", ["/pid", String(pid), "/F", "/T"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        interruptProcessTree(pid);
      }
    } else {
      child.kill();
    }
    acp.close();
  };

  const close = () => {
    terminate();
  };

  /**
   * 强制销毁（issue #136）：close() 置位 closed 后，进程 exit 事件不再触发
   * processFailure 拒绝，pending 请求会永久挂在 Promise.race 上。destroy 必须
   * 显式拒绝 processFailure，让所有未结算的 ACP 请求立即结束。
   */
  const destroy = () => {
    terminate();
    rejectProcessFailure(new Error(`${displayName} ACP connection was destroyed.`));
  };

  return {
    pid,
    initialize: (params) => request(acp.agent.request(methods.agent.initialize, params)),
    newSession: (params) => request(acp.agent.request(methods.agent.session.new, params)),
    loadSession: async (params) => {
      await request(acp.agent.request(methods.agent.session.load, params));
    },
    resumeSession: async (params) => {
      await request(acp.agent.request(methods.agent.session.resume, params));
    },
    prompt: (params) => request(acp.agent.request(methods.agent.session.prompt, params)),
    cancel: (sessionId) => request(acp.agent.notify(methods.agent.session.cancel, { sessionId })),
    close,
    destroy,
  };
}

function createEnv(
  definition: AcpRuntimeDefinition,
  agentId: AgentId,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...env,
    ORBIT_AGENT_ID: agentId,
  };
  for (const name of definition.agentIdEnvNames ?? []) {
    result[name] = agentId;
  }
  return result;
}
