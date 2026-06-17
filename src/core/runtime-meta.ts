import type { AgentRuntimeKind } from "../shared/types.ts";

export const AGENT_RUNTIME_PRIORITY: readonly AgentRuntimeKind[] = ["claude-code", "codex", "codebuddy"];

/** Map AgentRuntimeKind to CLI probe key: claude-code → claude */
export function runtimeKindToCliKey(runtime: string): string {
  return runtime === "claude-code" ? "claude" : runtime;
}

/** Shared runtime metadata — labels, setup commands, and install URLs in one place */
export type RuntimeMeta = { label: string; installUrl: string; installCommand: string };

export function runtimeMeta(runtime: string): RuntimeMeta {
  switch (runtime) {
    case "claude-code":
      return {
        label: "Claude Code",
        installUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
        installCommand: "npm install -g @anthropic-ai/claude-code",
      };
    case "codex":
      return {
        label: "OpenAI Codex",
        installUrl: "https://developers.openai.com/codex/cli",
        installCommand: "npm install -g @openai/codex",
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
