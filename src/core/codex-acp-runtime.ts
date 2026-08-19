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

export type CodexAcpRunOptions = AcpRunOptions;
export type CodexAcpConnection = AcpConnection;
export type CodexAcpConnector = AcpConnector;

export function resolveCodexAcpCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_ACP_PATH?.trim() || resolveBundledCommand(
    "codex-acp",
    env,
  );
}

export function buildCodexAcpCommand(
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  const command = resolveCodexAcpCommand(env);
  if (os.platform() !== "win32") {
    return { file: command, args: [] };
  }

  const windowsCommand = /\.(?:cmd|bat|exe)$/i.test(command) ? command : `${command}.cmd`;
  return { file: "cmd.exe", args: ["/d", "/s", "/c", windowsCommand] };
}

export function codexAcpEnvForRun(options: Pick<CodexAcpRunOptions, "approvalMode">): NodeJS.ProcessEnv {
  return {
    INITIAL_AGENT_MODE: options.approvalMode === "full-access" ? "agent-full-access" : "agent",
  };
}

export function isCodexDiagnosticMessage(update: Parameters<NonNullable<AcpRuntimeDefinition["isDiagnosticMessage"]>>[0]): boolean {
  return update.sessionUpdate === "agent_message_chunk"
    && update.content.type === "text"
    && !("messageId" in update && update.messageId)
    && /^(?:Config warning|Warning):/.test(update.content.text);
}

export function classifyCodexAnswerChunk(
  update: Parameters<NonNullable<AcpRuntimeDefinition["classifyAnswerChunk"]>>[0],
): ReturnType<NonNullable<AcpRuntimeDefinition["classifyAnswerChunk"]>> {
  const meta = update._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const codexMeta = meta.codex;
  if (!codexMeta || typeof codexMeta !== "object") return undefined;
  const phase = (codexMeta as Record<string, unknown>).phase;
  if (phase === "final_answer") return "final";
  if (phase === "commentary") return "progress";
  return undefined;
}

export const CODEX_ACP: AcpRuntimeDefinition = {
  kind: "codex",
  displayName: "Codex",
  buildCommand: buildCodexAcpCommand,
  agentIdEnvNames: ["CODEX_AGENT_ID"],
  envForRun: codexAcpEnvForRun,
  isDiagnosticMessage: isCodexDiagnosticMessage,
  classifyAnswerChunk: classifyCodexAnswerChunk,
};

export function createCodexAcpRuntime(
  connector?: CodexAcpConnector,
): AgentRuntime {
  return createAcpRuntime(CODEX_ACP, connector);
}

export function runCodexAcp(
  options: CodexAcpRunOptions,
  connector?: CodexAcpConnector,
): AgentRuntimeRunHandle {
  return runAcp(options, CODEX_ACP, connector);
}

export const codexRuntime = createCodexAcpRuntime();
