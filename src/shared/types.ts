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

export type AgentProfile = {
  id: AgentId;
  name: string;
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
  status: AgentStatus;
  selected?: boolean;
};

export type ChatMessageKind = "user" | "agent" | "system";

export type ChatMessageStatus = "sent" | "running" | "done" | "error";

export type MessageRouteState = "unprocessed" | "ignored" | "routed" | "blocked";

export type AgentActivityEvent =
  | { type: "status"; text: string; timestamp: string }
  | { type: "tool.started"; name: string; input?: string; timestamp: string }
  | { type: "tool.completed"; name: string; summary?: string; timestamp: string }
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
};

export type NewChatMessage = Omit<ChatMessage, "id" | "createdAt"> & {
  id?: never;
  createdAt?: never;
};

export type RuntimeEvent =
  | { type: "message.created"; message: ChatMessage }
  | { type: "message.updated"; message: ChatMessage }
  | { type: "agent.status"; agentId: AgentId; status: AgentStatus }
  | { type: "run.activity"; agentId: AgentId; runId: string; activity: AgentActivityEvent }
  | { type: "terminal.chunk"; agentId: AgentId; runId?: string; text: string }
  | { type: "run.completed"; agentId: AgentId; runId: string; resultMessageId: string }
  | { type: "run.failed"; agentId: AgentId; runId: string; error: string };

export type TerminalState = Record<string, string>;

export type AppState = {
  messages: ChatMessage[];
  agents: AgentState[];
  terminal: TerminalState;
};
