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

export const AGENT_RUNTIME_KINDS: readonly AgentRuntimeKind[] = ["claude-code", "codex", "codebuddy"];

export function isAgentRuntimeKind(value: unknown): value is AgentRuntimeKind {
  return value === "claude-code" || value === "codex" || value === "codebuddy";
}

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

/**
 * 监工配置（issue #153）：会话级保存，用户可在协作模式菜单里修改。
 * model 沿用普通员工的 runtime 归属门控——偏好所属 runtime 与 runtime 不一致时不应用、不显示。
 */
export type SupervisorConfig = {
  runtime: AgentRuntimeKind;
  model?: AgentModelPreference;
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

/**
 * runtime 会话通过 ACP `available_commands_update` 通告的一条原生斜杠命令
 * （issue #160）。name 不含前导 "/"；inputHint 对应 ACP 的
 * UnstructuredCommandInput.hint，缺失表示该命令不接收输入。
 */
export type AgentCommand = {
  name: string;
  description: string;
  inputHint?: string;
};

/**
 * 目标员工斜杠命令快照（issue #160）。`ready` 表示已拿到 runtime 会话的
 * `available_commands_update`（commands 为空表示该员工当前没有可用命令）；
 * `error` 表示主动探测失败（message 携带原因，可重试）。快照缺失表示尚未
 * 获取过，UI 据此在菜单打开时自动触发一次探测，不再把“未获取”误显示为
 * “没有命令”。
 */
export type AgentCommandsSnapshot = {
  status: "ready" | "error";
  commands: readonly AgentCommand[];
  message?: string;
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

export type AttachmentKind = "image" | "file";

type MessageAttachmentBase = {
  id: string;
  filename: string;
  path: string;
  url: string;
  size: number;
  width?: number;
  height?: number;
  createdAt: string;
};

/**
 * 附件判别联合：图片（图片能力开启时进入 ACP image 块，并作为缩略图
 * 预览）与文件（PDF/文本/代码）。凡不是原生 image 块的附件一律以 ACP
 * `resource_link` 内容块传递（file:// URI 指向服务端存储的文件）；下载
 * 时强制为附件响应。
 */
export type MessageAttachment = MessageAttachmentBase & (
  | { kind: "image"; mimeType: "image/png" | "image/jpeg" | "image/webp" }
  | { kind: "file"; mimeType: string }
);

export type DraftAttachmentInfo = {
  id: string;
  kind: AttachmentKind;
  mimeType: string;
  filename: string;
  size: number;
  /** 仅图片提供预览 URL；文件以 chip 展示。 */
  previewUrl?: string;
};

export const ATTACHMENT_LIMITS = {
  MAX_FILE_SIZE: 5 * 1024 * 1024,
  MAX_FILES_PER_MESSAGE: 5,
  /**
   * 单条消息附件的合计字节上限。理论上 5 个文件 × 5MB = 25MB，但图片会以
   * base64 内联进 ACP prompt（体积膨胀约 4/3），且发送时是同步读取，故把
   * 合计压到 20MB 以约束单次 prompt 体积与内存峰值。
   */
  MAX_TOTAL_SIZE_PER_MESSAGE: 20 * 1024 * 1024,
  ALLOWED_IMAGE_MIME_TYPES: ["image/png", "image/jpeg", "image/webp"],
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
  /** Client-generated id used to make message retries idempotent per conversation. */
  clientMessageId?: string;
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
  | { type: "message.created"; workspaceId?: string; conversationId: string; message: ChatMessage }
  | {
      type: "message.updated";
      workspaceId?: string;
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
  | { type: "agent.status"; workspaceId?: string; conversationId: string; agentId: AgentId; status: AgentStatus }
  | { type: "runtime.activity"; workspaceId?: string; conversationId: string; agentId: AgentId; runId: string; activity: AgentActivityEvent }
  | { type: "run.activity"; workspaceId?: string; conversationId: string; agentId: AgentId; runId: string; activity: AgentActivityEvent }
  | { type: "terminal.chunk"; workspaceId?: string; conversationId: string; agentId: AgentId; runId?: string; text: string }
  | { type: "run.completed"; workspaceId?: string; conversationId: string; agentId: AgentId; runId: string; resultMessageId: string; suppressFollowupRouting?: boolean }
  | { type: "run.failed"; workspaceId?: string; conversationId: string; agentId: AgentId; runId: string; error: string; interactionMode?: InteractionMode }
  | { type: "run.cancelled"; workspaceId?: string; conversationId: string; agentId: AgentId; runId: string; resultMessageId: string }
  | { type: "run.sessionId"; workspaceId?: string; conversationId: string; agentId: AgentId; runId: string; sessionId: string }
  | { type: "permission.requested"; workspaceId?: string; conversationId: string; permission: PendingPermission }
  | { type: "permission.resolved"; workspaceId?: string; conversationId: string; requestId: string }
  | { type: "elicitation.requested"; workspaceId?: string; conversationId: string; elicitation: PendingElicitation }
  | { type: "elicitation.resolved"; workspaceId?: string; conversationId: string; requestId: string }
  | { type: "running.updated"; summaries: RunningSummary[] }
  | { type: "runtime.availability.updated"; availability: RuntimeAvailability[] }
  // conversationId 用于按页面隔离监工的模型快照（issue #153）：
  // 监工是内部保留 ID，多个会话共享 agentId "supervisor"，不带会话维度会把
  // 一个会话的监工状态广播给同工作区的其他页面。
  | { type: "agent.model_state"; workspaceId: string; agentId: AgentId; modelState: AgentModelStateSnapshot; conversationId?: string }
  // 员工 runtime 会话的斜杠命令快照（issue #160）。命令属于具体会话里的
  // 后端 runtime 会话，因此是会话级事件；workspaceId 由发布方补齐。
  // status/message 仅主动探测路径携带：失败时 commands 为空、status 为 error。
  | { type: "agent.commands.updated"; workspaceId?: string; conversationId: string; agentId: AgentId; commands: readonly AgentCommand[]; status?: AgentCommandsSnapshot["status"]; message?: string }
  | { type: "events.gap"; workspaceId?: string; conversationId?: string };

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
  /**
   * 复杂协作（监工）的运行时与模型偏好（issue #153）。
   * 旧记录只有 supervisionRuntime，读取时由 ConversationStore 映射为
   * `{ runtime: supervisionRuntime }`；新写入只用本字段。
   */
  supervisorConfig?: SupervisorConfig;
  /** 已废弃（issue #153）：仅用于读取旧记录的监工运行时，新代码请用 supervisorConfig。 */
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
  /** 各数字员工 runtime 会话的斜杠命令快照（issue #160），供输入框 "/" 菜单使用。 */
  agentCommands: Record<AgentId, AgentCommandsSnapshot>;
};
