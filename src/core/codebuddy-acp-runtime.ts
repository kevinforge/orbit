import os from "node:os";

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

import {
  createAcpRuntime,
  decideAcpPermission,
  resolveAcpElicitation,
  resolveAcpPermission,
  runAcp,
  type AcpConnection,
  type AcpConnector,
  type AcpRunOptions,
  type AcpRuntimeDefinition,
} from "./acp-runtime.ts";
import type { AgentRuntime, AgentRuntimeRunHandle } from "./agent-runtime.ts";

export type CodeBuddyAcpRunOptions = AcpRunOptions;
export type CodeBuddyAcpConnection = AcpConnection;
export type CodeBuddyAcpConnector = AcpConnector;

export function buildCodeBuddyAcpArgs(): string[] {
  return ["--acp"];
}

export function buildCodeBuddyAcpCommand(): { file: string; args: string[] } {
  const args = buildCodeBuddyAcpArgs();
  if (os.platform() !== "win32") {
    return { file: "codebuddy", args };
  }

  return { file: "cmd.exe", args: ["/d", "/s", "/c", "codebuddy.cmd", ...args] };
}

const CODEBUDDY_ACP: AcpRuntimeDefinition = {
  kind: "codebuddy",
  displayName: "CodeBuddy",
  buildCommand: buildCodeBuddyAcpCommand,
  agentIdEnvNames: ["CODEBUDDY_AGENT_ID"],
  toolNameMetaKeys: ["codebuddy.ai/toolName"],
};

export function createCodeBuddyAcpRuntime(
  connector?: CodeBuddyAcpConnector,
): AgentRuntime {
  return createAcpRuntime(CODEBUDDY_ACP, connector);
}

export function runCodeBuddyAcp(
  options: CodeBuddyAcpRunOptions,
  connector?: CodeBuddyAcpConnector,
): AgentRuntimeRunHandle {
  return runAcp(options, CODEBUDDY_ACP, connector);
}

export function decideCodeBuddyPermission(
  request: RequestPermissionRequest,
): RequestPermissionResponse {
  return decideAcpPermission(request);
}

export function resolveCodeBuddyPermission(
  request: RequestPermissionRequest,
  options: CodeBuddyAcpRunOptions,
): Promise<RequestPermissionResponse> {
  return resolveAcpPermission(request, options, CODEBUDDY_ACP);
}

export function resolveCodeBuddyElicitation(
  request: CreateElicitationRequest,
  options: CodeBuddyAcpRunOptions,
): Promise<CreateElicitationResponse> {
  return resolveAcpElicitation(request, options);
}

export const codeBuddyRuntime = createCodeBuddyAcpRuntime();
