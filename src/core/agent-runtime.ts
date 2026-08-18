import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  AgentActivityEvent,
  AgentId,
  AgentPermissionRequest,
  AgentRuntimeKind,
  AgentElicitationRequest,
  ApprovalMode,
  ElicitationResponse,
  PermissionDecision,
} from "../shared/types.ts";

export class AgentRunCancelledError extends Error {
  readonly userMessage: string;

  constructor(message: string, userMessage = "运行已取消。") {
    super(message);
    this.name = "AgentRunCancelledError";
    this.userMessage = userMessage;
  }
}

export function isAgentRunCancelledError(error: unknown): error is AgentRunCancelledError {
  return error instanceof AgentRunCancelledError;
}

export type AgentRuntimeRunOptions = {
  agentId: AgentId;
  prompt: string;
  cwd: string;
  approvalMode?: ApprovalMode;
  requestPermission?: (request: AgentPermissionRequest) => Promise<PermissionDecision>;
  requestElicitation?: (request: AgentElicitationRequest) => Promise<ElicitationResponse>;
  resumeSessionId?: string;
  env?: NodeJS.ProcessEnv;
  onOutput?: (text: string) => void;
  onActivity?: (activity: AgentActivityEvent) => void;
  imagePaths?: string[];
  /** Stable owner key used to prevent ACP process reuse across conversations. */
  poolKey?: string;
};

export type AgentRuntimeRunHandle = {
  process: {
    kill: () => void;
    pid: number;
    /** Hard interrupt: terminate entire process tree (not just parent process). */
    interrupt: () => void;
  };
  result: Promise<string>;
  sessionId: Promise<string | null>;
};

export interface AgentRuntime {
  readonly kind: AgentRuntimeKind;
  readonly transport?: "cli" | "acp";
  readonly protocolVersion?: number;
  run(input: AgentRuntimeRunOptions): AgentRuntimeRunHandle;
}
