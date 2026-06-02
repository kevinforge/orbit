/** Map AgentRuntimeKind to CLI probe key: claude-code → claude */
export function runtimeKindToCliKey(runtime: string): string {
  return runtime === "claude-code" ? "claude" : runtime;
}

/** Shared runtime metadata — labels and install URLs in one place */
export type RuntimeMeta = { label: string; installUrl: string };

export function runtimeMeta(runtime: string): RuntimeMeta {
  switch (runtime) {
    case "claude-code":
      return { label: "Claude Code", installUrl: "https://docs.anthropic.com/en/docs/claude-code/overview" };
    case "codex":
      return { label: "OpenAI Codex", installUrl: "https://github.com/openai/codex" };
    case "codebuddy":
      return { label: "CodeBuddy", installUrl: "https://www.codebuddy.ai/cli" };
    default:
      return { label: runtime, installUrl: "" };
  }
}
