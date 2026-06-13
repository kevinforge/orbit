import type { AgentRuntimeKind } from "../shared/types.ts";

export const AGENT_RUNTIME_PRIORITY: readonly AgentRuntimeKind[] = ["claude-code", "codex", "codebuddy"];

/** Map AgentRuntimeKind to CLI probe key: claude-code → claude */
export function runtimeKindToCliKey(runtime: string): string {
  return runtime === "claude-code" ? "claude" : runtime;
}

/** Shared runtime metadata — labels and install URLs in one place */
export type RuntimeMeta = { label: string; installUrl: string };

export function runtimeMeta(runtime: string): RuntimeMeta {
  switch (runtime) {
    case "claude-code":
      return { label: "Claude Code", installUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart" };
    case "codex":
      return { label: "OpenAI Codex", installUrl: "https://developers.openai.com/codex/cli" };
    case "codebuddy":
      return { label: "CodeBuddy", installUrl: "https://www.codebuddy.ai/docs/cli/installation" };
    default:
      return { label: runtime, installUrl: "" };
  }
}
