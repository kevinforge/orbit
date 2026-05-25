import type { AgentId, AgentRuntimeKind, PermissionProfile } from "../shared/types.ts";

export type AgentRunInput = {
  runId: string;
  agentId: AgentId;
  prompt: string;
  cwd: string;
  permissionProfile: PermissionProfile;
};

export type AgentRuntimeEvent =
  | { type: "activity"; text: string }
  | { type: "tool.started"; name: string; input?: string }
  | { type: "tool.completed"; name: string; summary?: string }
  | { type: "final"; content: string }
  | { type: "error"; message: string };

export interface AgentRuntime {
  readonly kind: AgentRuntimeKind;
  run(input: AgentRunInput): AsyncIterable<AgentRuntimeEvent>;
  cancel(runId: string): Promise<void>;
}

