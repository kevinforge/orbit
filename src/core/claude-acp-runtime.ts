import os from "node:os";

import {
  createAcpRuntime,
  runAcp,
  type AcpConnection,
  type AcpConnector,
  type AcpRunOptions,
  type AcpRuntimeDefinition,
} from "./acp-runtime.ts";
import type { AgentRuntime, AgentRuntimeRunHandle } from "./agent-runtime.ts";
import { resolveBundledCommand } from "./bundled-runtime.ts";

export type ClaudeAcpRunOptions = AcpRunOptions;
export type ClaudeAcpConnection = AcpConnection;
export type ClaudeAcpConnector = AcpConnector;

export function resolveClaudeAcpCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_ACP_PATH?.trim() || resolveBundledCommand(
    "claude-agent-acp",
    env,
  );
}

export function buildClaudeAcpCommand(
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  const command = resolveClaudeAcpCommand(env);

  if (os.platform() !== "win32") {
    return { file: command, args: [] };
  }

  const windowsCommand = /\.(?:cmd|bat|exe)$/i.test(command) ? command : `${command}.cmd`;
  return { file: "cmd.exe", args: ["/d", "/s", "/c", windowsCommand] };
}

const CLAUDE_ACP: AcpRuntimeDefinition = {
  kind: "claude-code",
  displayName: "Claude Code",
  buildCommand: buildClaudeAcpCommand,
  agentIdEnvNames: ["CLAUDE_AGENT_ID"],
};

export function createClaudeAcpRuntime(
  connector?: ClaudeAcpConnector,
): AgentRuntime {
  return createAcpRuntime(CLAUDE_ACP, connector);
}

export function runClaudeAcp(
  options: ClaudeAcpRunOptions,
  connector?: ClaudeAcpConnector,
): AgentRuntimeRunHandle {
  return runAcp(options, CLAUDE_ACP, connector);
}

export const claudeCodeRuntime = createClaudeAcpRuntime();
