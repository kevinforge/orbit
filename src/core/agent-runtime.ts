import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  AgentActivityEvent,
  AgentId,
  AgentPermissionRequest,
  AgentRuntimeKind,
  ApprovalMode,
  PermissionDecision,
} from "../shared/types.ts";

export type AgentRuntimeRunOptions = {
  agentId: AgentId;
  prompt: string;
  cwd: string;
  approvalMode?: ApprovalMode;
  requestPermission?: (request: AgentPermissionRequest) => Promise<PermissionDecision>;
  resumeSessionId?: string;
  env?: NodeJS.ProcessEnv;
  onOutput?: (text: string) => void;
  onActivity?: (activity: AgentActivityEvent) => void;
  imagePaths?: string[];
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
