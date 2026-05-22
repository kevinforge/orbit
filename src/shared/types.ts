export type AgentId = "agent1" | "agent2";

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
};

export type NewChatMessage = Omit<ChatMessage, "id" | "createdAt"> & {
  id?: never;
  createdAt?: never;
};

export type RuntimeEvent =
  | { type: "message.created"; message: ChatMessage }
  | { type: "message.updated"; message: ChatMessage }
  | { type: "agent.status"; agentId: AgentId; status: AgentStatus }
  | { type: "terminal.chunk"; agentId: AgentId; runId?: string; text: string }
  | { type: "run.completed"; agentId: AgentId; runId: string; resultMessageId: string }
  | { type: "run.failed"; agentId: AgentId; runId: string; error: string };

export type TerminalState = Record<AgentId, string>;

export type AppState = {
  messages: ChatMessage[];
  agents: AgentState[];
  terminal: TerminalState;
};
