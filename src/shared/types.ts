export type AgentId = string;

export type ApprovalMode = "ask" | "full-access";

/** 会话交互模式：普通对话 / 简单协作 / 复杂协作（内置监工）。 */
export type InteractionMode = "direct" | "collaborative" | "supervised";

export const INTERACTION_MODES: readonly InteractionMode[] = ["direct", "collaborative", "supervised"];

export function isInteractionMode(value: unknown): value is InteractionMode {
  return value === "direct" || value === "collaborative" || value === "supervised";
}

export type PermissionDecision = "allow" | "reject";

export type AgentPermissionRequest = {
  id: string;
  title: string;
  kind?: string;
  input?: string;
  locations?: string[];
};

export type ElicitationFieldSchema = {
  type: "string" | "number" | "integer" | "boolean" | "array" | string;
  title?: string | null;
  description?: string | null;
  default?: string | number | boolean | string[] | null;
  enum?: string[] | null;
  oneOf?: Array<{ const: string; title: string; description?: string | null }> | null;
  minimum?: number | null;
  maximum?: number | null;
  minLength?: number | null;
  maxLength?: number | null;
  minItems?: number | null;
  maxItems?: number | null;
  items?: { type?: string; enum?: string[]; anyOf?: Array<{ const: string; title: string; description?: string | null }> };
};

export type ElicitationSchema = {
  type?: "object";
  title?: string | null;
  description?: string | null;
  properties?: Record<string, ElicitationFieldSchema>;
  required?: string[] | null;
};

export type AgentElicitationRequest = {
  id?: string;
  message: string;
  mode: "form" | "url" | string;
  requestedSchema?: ElicitationSchema;
  elicitationId?: string;
  url?: string;
  sessionId?: string;
  toolCallId?: string | null;
};

export type ElicitationContent = Record<string, string | number | boolean | string[]>;

export type ElicitationResponse =
  | { action: "accept"; content?: ElicitationContent }
  | { action: "decline" }
  | { action: "cancel" };

export type PendingElicitation = Omit<AgentElicitationRequest, "id"> & {
  id: string;
  conversationId: string;
  agentId: AgentId;
  runId: string;
  createdAt: string;
  expiresAt: string;
};

export type PendingPermission = AgentPermissionRequest & {
  conversationId: string;
  agentId: AgentId;
  runId: string;
  createdAt: string;
  expiresAt: string;
};

export type AgentRuntimeKind = "claude-code" | "codex" | "codebuddy";

export type ChannelWatchTriggers = {
  onUnassignedMessage?: boolean;
  onAgentBlocked?: boolean;
  /** Trigger when an agent run fails. Issue #82 */
  onRunFailed?: boolean;
  /** Maximum automatic triggers per conversation (default 5). */
  maxTriggersPerConversation?: number;
  /** Minimum milliseconds between consecutive triggers (default 2000). */
  debounceMs?: number;
};

export function hasActiveChannelWatchTriggers(triggers?: ChannelWatchTriggers): boolean {
  return (
    triggers?.onUnassignedMessage === true ||
    triggers?.onAgentBlocked === true ||
    triggers?.onRunFailed === true
  );
}

/**
 * 员工的模型偏好（issue #142）：preferredModelId 是 runtime config options 里
 * model 选项的 value ID；runtimeKind 记录选择偏好时所处的 runtime，员工切换
 * runtime 后偏好不再生效（value ID 不通用）。每次运行开始时惰性应用。
 */
export type AgentModelPreference = {
  preferredModelId?: string;
  runtimeKind: AgentRuntimeKind;
};

export type AgentConfig = {
  id: AgentId;
  name: string;
  description?: string;
  runtime: AgentRuntimeKind;
  systemPrompt: string;
  enabled: boolean;
  triggers?: ChannelWatchTriggers;
  model?: AgentModelPreference;
};

export type AgentTemplate = Omit<AgentConfig, "enabled" | "triggers">;

export type AgentTeamTemplate = {
  id: string;
  name: string;
  description: string;
  members: AgentTemplate[];
};

export type AgentProfile = {
  id: AgentId;
  name: string;
  description?: string;
  runtime: AgentRuntimeKind;
  cwd: string;
  systemPrompt: string;
  triggers?: ChannelWatchTriggers;
  /** 已按 runtime 匹配门控的首选模型 ID（issue #142）；运行开始时惰性应用。 */
  preferredModelId?: string;
  internal?: boolean;
};

/** 模型选项的一个可选值（来自 runtime 的 session config options，issue #142）。 */
export type AgentModelChoice = {
  value: string;
  name: string;
};

/**
 * 员工 runtime 会话的模型配置快照（issue #142）。runtime 每次新建或恢复会话
 * 都会返回 config options；Orbit 抽取其中 category 为 "model" 的 select 选项
 * 生成本快照。choices 为空表示该 runtime 不提供模型选择。
 */
export type AgentModelStateSnapshot = {
  agentId: AgentId;
  runtimeKind: AgentRuntimeKind;
  /** 模型选项在 ACP config options 里的 configId（三 runtime 实测均为 "model"）。 */
  configId: string;
  choices: AgentModelChoice[];
  currentValue: string | undefined;
  /** currentValue 是否来自真实员工会话；探测会话只提供可选列表。 */
  currentValueSource?: "probe" | "session";
  updatedAt: string;
};

export type AgentModelProbeStatus = "idle" | "loading" | "ready" | "unsupported" | "error";

export type AgentModelProbeState = {
  runtimeKind: AgentRuntimeKind;
  status: AgentModelProbeStatus;
  message?: string;
  updatedAt?: string;
};

/**
 * /api/agents 响应条目（issue #142）：数字员工配置合并该员工当前的模型快照。
 * 快照由 runtime 写入独立存储，只随响应展示，不属于 agents.json 的用户配置。
 */
export type AgentConfigWithModelState = AgentConfig & {
  modelState?: AgentModelStateSnapshot;
  modelProbe?: AgentModelProbeState;
};

/**
 * 设置页可以在保存员工配置前切换 runtime，因此模型探测结果不能只依附于
 * 服务端已保存的 AgentConfig。target 单独描述本次实际探测的员工和 runtime。
 */
export type AgentModelProbeResponse = {
  configs: AgentConfigWithModelState[];
  target?: {
    agentId: AgentId;
    runtimeKind: AgentRuntimeKind;
    modelState: AgentModelStateSnapshot | null;
    modelProbe: AgentModelProbeState;
  };
};

export type AgentStatus = "starting" | "idle" | "running" | "error" | "stopped";

export type AgentState = {
  id: AgentId;
  label: string;
  runtime: AgentRuntimeKind;
  status: AgentStatus;
  triggers?: ChannelWatchTriggers;
  selected?: boolean;
  runtimeAvailable?: boolean;
};

export type MessageAttachment = {
  id: string;
  kind: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  filename: string;
  path: string;
  url: string;
  size: number;
  width?: number;
  height?: number;
  createdAt: string;
};

export type DraftAttachmentInfo = {
  id: string;
  kind: "image";
  mimeType: string;
  filename: string;
  size: number;
  previewUrl: string;
};

export const ATTACHMENT_LIMITS = {
  MAX_FILE_SIZE: 5 * 1024 * 1024,
  MAX_FILES_PER_MESSAGE: 5,
  ALLOWED_MIME_TYPES: ["image/png", "image/jpeg", "image/webp"],
  DRAFT_MAX_AGE_MS: 1 * 60 * 60 * 1000, // Issue #88: 清理频率从24小时改为1小时
  MAX_DRAFTS_PER_CONVERSATION: 20, // Issue #88: 每会话最多20个draft
} as const;

export type ChatMessageKind = "user" | "agent" | "system";

export type ChatMessageStatus = "sent" | "running" | "cancelling" | "done" | "error" | "cancelled";

export type MessageRouteState = "unprocessed" | "ignored" | "routed" | "blocked";

export type AgentPlanEntry = {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
};

export type AgentPlanSnapshot =
  | { id?: string; format: "items"; entries: AgentPlanEntry[] }
  | { id: string; format: "markdown"; content: string }
  | { id: string; format: "file"; uri: string };

export type PersistedProcessTimelineEntry =
  | { type: "text"; text: string }
  | { type: "tools"; count: number; failedCount: number };

export type AgentActivityEvent =
  | { type: "status"; text: string; timestamp: string }
  | { type: "tool.started"; toolCallId?: string; name: string; input?: string; timestamp: string }
  | { type: "tool.completed"; toolCallId?: string; name: string; summary?: string; timestamp: string }
  | { type: "tool.failed"; toolCallId?: string; name: string; summary?: string; timestamp: string }
  | { type: "plan.updated"; plan: AgentPlanSnapshot; timestamp: string }
  | { type: "plan.removed"; planId: string; timestamp: string }
  | { type: "error"; message: string; timestamp: string }
  /**
   * 运行时明确输出的过程文本（模型说明、进度叙述等，不含最终回复正文）。
   * `text` 为增量分片；`snapshot: true` 时为结算全量替换（例如运行结束时剔除
   * 已归入最终回复的文本后重写过程区）。仅 delta + 结算快照两种语义，
   * 消费端按顺序追加或整体替换，避免流式分片乱序与重复。结算快照由
   * RunManager 在服务端内部消化，不作为前端 `run.activity` 事件转发。
   */
  | {
      type: "process.text";
      text: string;
      snapshot?: boolean;
      /** ACP answer group used to remove the final reply from the transient process timeline. */
      answerGroup?: string;
      stream?: "progress" | "answer";
      /** Runtime explicitly marked this chunk as part of the final visible answer. */
      isFinal?: boolean;
      /** Present on a settlement snapshot, including when the selected group is the empty string. */
      excludedAnswerGroup?: string;
      timestamp: string;
    };

export type ChatMessage = {
  id: string;
  kind: ChatMessageKind;
  agentId?: AgentId;
  content: string;
  createdAt: string;
  status?: ChatMessageStatus;
  runId?: string;
  runStatus?: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  parentMessageId?: string;
  routeState?: MessageRouteState;
  routeDepth?: number;
  /** 模式快照：用户消息在发送时记录当轮 interaction mode，派生运行/转交/监工检查继承该值。 */
  interactionMode?: InteractionMode;
  activity?: AgentActivityEvent[];
  /** 结算后的轻量过程顺序；工具段仅保留数量与失败数，不保存调用详情。 */
  processTimeline?: PersistedProcessTimelineEntry[] | null;
  /** 最终 Plan 快照（运行结束时的最新计划）。`null` 表示结算时明确清空。 */
  plan?: AgentPlanSnapshot | null;
  startedAt?: string;
  completedAt?: string;
  sessionId?: string;
  runIndex?: number;
  attachments?: MessageAttachment[];
  approvalMode?: ApprovalMode;
  /** 排队任务被全局停止时标记：前端据此过滤，不渲染该消息。仅 interruptAll 丢弃排队任务时设置。 */
  discarded?: boolean;
};

export type RunResult = {
  content: string;
  sessionId?: string;
  runIndex?: number;
};

export type NewChatMessage = Omit<ChatMessage, "id" | "createdAt"> & {
  id?: never;
  createdAt?: never;
};

export type RunningSummary = {
  workspaceId: string;
  conversationId: string;
  runningAgentIds: AgentId[];
};

export type WorkTaskStatus = "running" | "completed" | "failed" | "cancelled";
export type WorkTaskRunStatus = "queued" | WorkTaskStatus;

export type WorkTaskAgent = {
  agentId: AgentId;
  label: string;
  status: WorkTaskRunStatus;
  durationMs: number;
  runCount: number;
};

export type WorkTaskRun = {
  id: string;
  agentId: AgentId;
  label: string;
  status: WorkTaskRunStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs: number;
  offsetMs: number;
  parentRunId?: string;
};

export type WorkTask = {
  id: string;
  conversationId: string;
  conversationName: string;
  title: string;
  status: WorkTaskStatus;
  createdAt: string;
  completedAt?: string;
  updatedAt: string;
  durationMs: number;
  agents: WorkTaskAgent[];
  runs: WorkTaskRun[];
  hasParallelRuns: boolean;
};

export type WorkAnalysisTrendPoint = {
  date: string;
  completedTasks: number;
  medianDurationMs: number;
};

export type WorkAnalysis = {
  workspaceId: string;
  days: number;
  generatedAt: string;
  summary: {
    totalTasks: number;
    runningTasks: number;
    completedTasks: number;
    failedTasks: number;
    cancelledTasks: number;
    participatingAgents: number;
    multiAgentRate: number;
    medianDurationMs: number;
  };
  trend: WorkAnalysisTrendPoint[];
  tasks: WorkTask[];
};

export type MessageHistoryState = {
  hasOlderMessages: boolean;
  olderCursor: string | null;
};

export type MessagePage = MessageHistoryState & {
  messages: ChatMessage[];
};

export type RuntimeEvent =
  | { type: "message.created"; conversationId: string; message: ChatMessage }
  | {
      type: "message.updated";
      conversationId: string;
      message: ChatMessage;
      settleTransientActivity?: boolean;
      /**
       * 结算快照标记的最终回答分组。终态事件携带它，客户端据此显式剔除实时
       * 过程区中的最终回答分片；缺失时保留当前实时活动（不剔除部分回答）。
       * 空字符串有效（未分组回答），判断必须用 `!== undefined`。
       */
      excludedAnswerGroup?: string;
    }
  | { type: "agent.status"; conversationId: string; agentId: AgentId; status: AgentStatus }
  | { type: "runtime.activity"; conversationId: string; agentId: AgentId; runId: string; activity: AgentActivityEvent }
  | { type: "run.activity"; conversationId: string; agentId: AgentId; runId: string; activity: AgentActivityEvent }
  | { type: "terminal.chunk"; conversationId: string; agentId: AgentId; runId?: string; text: string }
  | { type: "run.completed"; conversationId: string; agentId: AgentId; runId: string; resultMessageId: string; suppressFollowupRouting?: boolean }
  | { type: "run.failed"; conversationId: string; agentId: AgentId; runId: string; error: string; interactionMode?: InteractionMode }
  | { type: "run.cancelled"; conversationId: string; agentId: AgentId; runId: string; resultMessageId: string }
  | { type: "run.sessionId"; conversationId: string; agentId: AgentId; runId: string; sessionId: string }
  | { type: "permission.requested"; conversationId: string; permission: PendingPermission }
  | { type: "permission.resolved"; conversationId: string; requestId: string }
  | { type: "elicitation.requested"; conversationId: string; elicitation: PendingElicitation }
  | { type: "elicitation.resolved"; conversationId: string; requestId: string }
  | { type: "running.updated"; summaries: RunningSummary[] }
  | { type: "runtime.availability.updated"; availability: RuntimeAvailability[] }
  | { type: "agent.model_state"; workspaceId: string; agentId: AgentId; modelState: AgentModelStateSnapshot }
  | { type: "context.switched"; workspace: WorkspaceInfo; conversation: ConversationInfo };

export type TerminalState = Record<string, string>;

export type WorkspaceInfo = {
  id: string;
  name: string;
  path: string;
};

export type Workspace = WorkspaceInfo & {
  createdAt: string;
  lastOpenedAt: string;
};

export type ConversationInfo = {
  id: string;
  name: string;
  interactionMode?: InteractionMode;
  /** 普通对话模式下最近一位直接对话员工；切换到其他模式不清除，切回后继续。 */
  lastDirectAgentId?: AgentId;
  /** 内部字段：复杂协作（监工）使用的运行时，不对用户展示、不可由用户直接配置。 */
  supervisionRuntime?: AgentRuntimeKind;
};

export type Conversation = ConversationInfo & {
  workspaceId: string;
  createdAt: string;
  lastOpenedAt: string;
};

export type WorkspaceConfig = {
  systemPrompt?: string;
  rules?: string[];
};

export type WorkspacePreset = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  rules: string[];
  /** 关联的数字员工团队模板 id（对应 AGENT_TEAM_TEMPLATES）。设置后创建该模板工作区时会预置整个团队；未设置（如空白工作区）则不预置数字员工。 */
  teamId?: string;
  recommended?: boolean;
};

export type WorkspaceRuntimeConfig = {
  systemPrompt: string;
  rules: string[];
};

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceRuntimeConfig = {
  systemPrompt: "",
  rules: [],
};

/** 全局配置：跨工作区的设置 */
export type GlobalConfig = {
  /** 运行日志开关：记录数字员工运行日志到本地（用于问题排查，会占用磁盘空间）。默认关闭。 */
  enableRunLogs?: boolean;
};

export type GlobalRuntimeConfig = {
  enableRunLogs: boolean;
};

export const DEFAULT_GLOBAL_CONFIG: GlobalRuntimeConfig = {
  enableRunLogs: false, // 默认关闭，避免占用磁盘空间
};

export type RuntimeAvailability = {
  runtime: string;
  available: boolean;
  path: string | null;
  error?: string;
  checkedAt: string;
};

export type AppState = {
  workspace: WorkspaceInfo;
  conversation: ConversationInfo;
  messages: ChatMessage[];
  messageHistory: MessageHistoryState;
  agents: AgentState[];
  terminal: TerminalState;
  runningSummaries: RunningSummary[];
  runtimeAvailability: RuntimeAvailability[];
  pendingPermissions: PendingPermission[];
  pendingElicitations: PendingElicitation[];
  /** 各数字员工最新的模型快照（issue #142），供设置面板展示当前模型与可用列表。 */
  agentModelStates: Record<AgentId, AgentModelStateSnapshot>;
};
