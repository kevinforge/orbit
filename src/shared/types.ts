export type AgentId = string;

export type AgentRole = "pm" | "architect" | "developer" | "tester" | "general" | "coordinator";

export type PermissionProfile = {
  canReadFiles: boolean;
  canWriteFiles: boolean;
  canRunCommands: boolean;
  canInstallDependencies: boolean;
  canGitCommit: boolean;
  allowedDirectories: string[];
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

export type AgentConfigUi = {
  label?: string;
};

export type AgentConfig = {
  id: AgentId;
  name: string;
  description?: string;
  role: AgentRole;
  runtime: AgentRuntimeKind;
  systemPrompt: string;
  permissionProfile?: PermissionProfile;
  enabled: boolean;
  ui?: AgentConfigUi;
  triggers?: ChannelWatchTriggers;
};

export type AgentProfile = {
  id: AgentId;
  name: string;
  description?: string;
  role: AgentRole;
  runtime: AgentRuntimeKind;
  cwd: string;
  systemPrompt: string;
  permissionProfile: PermissionProfile;
  triggers?: ChannelWatchTriggers;
};

export type AgentStatus = "starting" | "idle" | "running" | "error" | "stopped";

export type AgentState = {
  id: AgentId;
  label: string;
  runtime: AgentRuntimeKind;
  status: AgentStatus;
  role: AgentRole;
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
  DRAFT_MAX_AGE_MS: 24 * 60 * 60 * 1000,
} as const;

export type ChatMessageKind = "user" | "agent" | "system";

export type ChatMessageStatus = "sent" | "running" | "done" | "error" | "cancelled";

export type MessageRouteState = "unprocessed" | "ignored" | "routed" | "blocked";

export type AgentActivityEvent =
  | { type: "status"; text: string; timestamp: string }
  | { type: "tool.started"; name: string; input?: string; timestamp: string }
  | { type: "tool.completed"; name: string; summary?: string; timestamp: string }
  | { type: "tool.failed"; name: string; summary?: string; timestamp: string }
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
  | { type: "run.activity"; conversationId: string; agentId: AgentId; runId: string; activity: AgentActivityEvent }
  | { type: "terminal.chunk"; conversationId: string; agentId: AgentId; runId?: string; text: string }
  | { type: "run.completed"; conversationId: string; agentId: AgentId; runId: string; resultMessageId: string; suppressFollowupRouting?: boolean }
  | { type: "run.failed"; conversationId: string; agentId: AgentId; runId: string; error: string }
  | { type: "run.cancelled"; conversationId: string; agentId: AgentId; runId: string; resultMessageId: string }
  | { type: "run.sessionId"; conversationId: string; agentId: AgentId; runId: string; sessionId: string }
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
};
