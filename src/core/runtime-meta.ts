import type { AgentRuntimeKind } from "../shared/types.ts";

export const AGENT_RUNTIME_PRIORITY: readonly AgentRuntimeKind[] = ["claude-code", "codex", "codebuddy"];

/** Map AgentRuntimeKind to the executable used by its transport. */
export function runtimeKindToCliKey(runtime: string): string {
  if (runtime === "claude-code") return "claude-agent-acp";
  if (runtime === "codex") return "codex-acp";
  return runtime;
}

/** Shared runtime metadata — labels, setup commands, and install URLs in one place */
export type RuntimeMeta = { label: string; installUrl: string; installCommand: string };

export function runtimeMeta(runtime: string): RuntimeMeta {
  switch (runtime) {
    case "claude-code":
      return {
        label: "Claude Code",
        installUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
        installCommand: "npm install -g @agentclientprotocol/claude-agent-acp",
      };
    case "codex":
      return {
        label: "OpenAI Codex",
        installUrl: "https://github.com/agentclientprotocol/codex-acp",
        installCommand: "npm install -g @openai/codex @agentclientprotocol/codex-acp",
      };
    case "codebuddy":
      return {
        label: "CodeBuddy",
        installUrl: "https://www.codebuddy.ai/docs/cli/installation",
        installCommand: "npm install -g @tencent-ai/codebuddy-code",
      };
    default:
      return { label: runtime, installUrl: "", installCommand: "" };
  }
}
