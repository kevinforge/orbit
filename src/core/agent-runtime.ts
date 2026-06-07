import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { AgentId, AgentRuntimeKind, PermissionProfile } from "../shared/types.ts";

export type AgentRuntimeRunOptions = {
  agentId: AgentId;
  prompt: string;
  cwd: string;
  permissionProfile: PermissionProfile;
  resumeSessionId?: string;
  env?: NodeJS.ProcessEnv;
  onOutput?: (text: string) => void;
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
  run(input: AgentRuntimeRunOptions): AgentRuntimeRunHandle;
}
