export type AgentId = string;

export type ApprovalMode = "ask" | "full-access";

export type SupervisionMode = "off" | "on";

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

export type AgentConfig = {
  id: AgentId;
  name: string;
  description?: string;
  runtime: AgentRuntimeKind;
  systemPrompt: string;
  enabled: boolean;
  triggers?: ChannelWatchTriggers;
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
  internal?: boolean;
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

export type ChatMessageStatus = "sent" | "running" | "done" | "error" | "cancelled";

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

export type AgentActivityEvent =
  | { type: "status"; text: string; timestamp: string }
  | { type: "tool.started"; name: string; input?: string; timestamp: string }
  | { type: "tool.completed"; name: string; summary?: string; timestamp: string }
  | { type: "tool.failed"; name: string; summary?: string; timestamp: string }
  | { type: "plan.updated"; plan: AgentPlanSnapshot; timestamp: string }
  | { type: "plan.removed"; planId: string; timestamp: string }
  | { type: "error"; message: string; timestamp: string };

export type ChatMessage = {
  id: string;
  kind: ChatMessageKind;
  agentId?: AgentId;
  content: string;
  createdAt: string;
  status?: ChatMessageStatus;
  runId?: string;
  runStatus?: "queued" | "running" | "completed" | "failed" | "cancelled";
  parentMessageId?: string;
  routeState?: MessageRouteState;
  routeDepth?: number;
  activity?: AgentActivityEvent[];
  startedAt?: string;
  completedAt?: string;
  sessionId?: string;
  runIndex?: number;
  attachments?: MessageAttachment[];
  approvalMode?: ApprovalMode;
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
  | { type: "message.updated"; conversationId: string; message: ChatMessage }
  | { type: "agent.status"; conversationId: string; agentId: AgentId; status: AgentStatus }
  | { type: "runtime.activity"; conversationId: string; agentId: AgentId; runId: string; activity: AgentActivityEvent }
  | { type: "run.activity"; conversationId: string; agentId: AgentId; runId: string; activity: AgentActivityEvent }
  | { type: "terminal.chunk"; conversationId: string; agentId: AgentId; runId?: string; text: string }
  | { type: "run.completed"; conversationId: string; agentId: AgentId; runId: string; resultMessageId: string; suppressFollowupRouting?: boolean }
  | { type: "run.failed"; conversationId: string; agentId: AgentId; runId: string; error: string }
  | { type: "run.cancelled"; conversationId: string; agentId: AgentId; runId: string; resultMessageId: string }
  | { type: "run.sessionId"; conversationId: string; agentId: AgentId; runId: string; sessionId: string }
  | { type: "permission.requested"; conversationId: string; permission: PendingPermission }
  | { type: "permission.resolved"; conversationId: string; requestId: string }
  | { type: "elicitation.requested"; conversationId: string; elicitation: PendingElicitation }
  | { type: "elicitation.resolved"; conversationId: string; requestId: string }
  | { type: "running.updated"; summaries: RunningSummary[] }
  | { type: "runtime.availability.updated"; availability: RuntimeAvailability[] }
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
  supervisionMode?: SupervisionMode;
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
};
