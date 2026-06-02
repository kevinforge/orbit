export type AgentId = string;

export type AgentRole = "pm" | "architect" | "developer" | "tester" | "general";

export type PermissionProfile = {
  canReadFiles: boolean;
  canWriteFiles: boolean;
  canRunCommands: boolean;
  canInstallDependencies: boolean;
  canGitCommit: boolean;
  allowedDirectories: string[];
};

export type AgentRuntimeKind = "claude-code" | "codex" | "codebuddy";

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
};

export type AgentStatus = "starting" | "idle" | "running" | "error" | "stopped";

export type AgentState = {
  id: AgentId;
  label: string;
  runtime: AgentRuntimeKind;
  status: AgentStatus;
  selected?: boolean;
  runtimeAvailable?: boolean;
};

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
  parentMessageId?: string;
  routeState?: MessageRouteState;
  routeDepth?: number;
  activity?: AgentActivityEvent[];
  startedAt?: string;
  completedAt?: string;
  sessionId?: string;
  runIndex?: number;
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

export type RuntimeEvent =
  | { type: "message.created"; conversationId: string; message: ChatMessage }
  | { type: "message.updated"; conversationId: string; message: ChatMessage }
  | { type: "agent.status"; conversationId: string; agentId: AgentId; status: AgentStatus }
  | { type: "run.activity"; conversationId: string; agentId: AgentId; runId: string; activity: AgentActivityEvent }
  | { type: "terminal.chunk"; conversationId: string; agentId: AgentId; runId?: string; text: string }
  | { type: "run.completed"; conversationId: string; agentId: AgentId; runId: string; resultMessageId: string }
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
  agents: AgentState[];
  terminal: TerminalState;
  runningSummaries: RunningSummary[];
  runtimeAvailability: RuntimeAvailability[];
};
