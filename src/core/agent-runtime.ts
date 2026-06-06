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
  process: Pick<ChildProcessWithoutNullStreams, "kill">;
  result: Promise<string>;
  sessionId: Promise<string | null>;
};

export interface AgentRuntime {
  readonly kind: AgentRuntimeKind;
  run(input: AgentRuntimeRunOptions): AgentRuntimeRunHandle;
}
