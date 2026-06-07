import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";

import type { AgentId } from "../shared/types.ts";
import type { AgentRuntime, AgentRuntimeRunHandle } from "./agent-runtime.ts";
import { extractReadableText } from "./ansi-text-extractor.ts";
import { parseJsonObjects } from "./json-stream-parser.ts";

/**
 * Claude CLI run options.
 * Note: Claude CLI does not support native --image parameter for passing images.
 * Images are injected via prompt through <current-attachments> XML block in agent-context-builder.ts.
 * The imagePaths parameter is omitted here since it's handled at the prompt construction level.
 */
export type ClaudeCliRunOptions = {
  agentId: AgentId;
  cwd: string;
  prompt: string;
  permissionProfile?: unknown;
  resumeSessionId?: string;
  env?: NodeJS.ProcessEnv;
  onOutput?: (text: string) => void;
};

export function buildClaudeCliArgs(options?: { resumeSessionId?: string }): string[] {
  const args = [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (options?.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  return args;
}

export function runClaudeCli(options: ClaudeCliRunOptions): AgentRuntimeRunHandle {
  const args = buildClaudeCliArgs({ resumeSessionId: options.resumeSessionId });
  const command = buildClaudeCliCommand(args);
  const child = spawn(command.file, command.args, {
    cwd: options.cwd,
    env: createEnv(options.agentId, options.env ?? process.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: os.platform() !== "win32", // Create process group on Unix for tree termination
  });

  let stdout = "";
  let stderr = "";

  let capturedSessionId: string | null = null;
  let sessionIdResolve!: (value: string | null) => void;
  const sessionIdPromise = new Promise<string | null>((resolve) => {
    sessionIdResolve = resolve;
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    const readable = extractReadableText(chunk);
    if (readable) {
      options.onOutput?.(readable);
    }

    if (!capturedSessionId) {
      const sessionId = extractSessionId(chunk);
      if (sessionId) {
        capturedSessionId = sessionId;
        sessionIdResolve(sessionId);
      }
    }
  });

  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    const readable = extractReadableText(chunk);
    if (readable) {
      options.onOutput?.(readable);
    }
  });

  const result = new Promise<string>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        if (!capturedSessionId) sessionIdResolve(null);
        reject(new Error(stderr.trim() || stdout.trim() || `Claude CLI exited with code ${code}`));
        return;
      }

      const parsed = extractClaudeCliFinalAnswer(stdout);
      if (!capturedSessionId && parsed.sessionId) {
        capturedSessionId = parsed.sessionId;
        sessionIdResolve(parsed.sessionId);
      }
      if (!capturedSessionId) sessionIdResolve(null);

      if (!parsed.text) {
        reject(new Error("Claude CLI completed without a final answer."));
        return;
      }

      resolve(parsed.text);
    });
  });

  child.stdin.end(options.prompt);

  const pid = child.pid!;

  return {
    process: {
      kill: () => child.kill(),
      pid,
      interrupt: () => interruptProcessTree(pid),
    },
    result,
    sessionId: sessionIdPromise,
  };
}

export function buildClaudeCliCommand(cliArgs?: string[]): { file: string; args: string[] } {
  const args = cliArgs ?? buildClaudeCliArgs();
  if (os.platform() !== "win32") {
    return { file: "claude", args };
  }

  return { file: "cmd.exe", args: ["/d", "/s", "/c", "claude.cmd", ...args] };
}

export const claudeCodeRuntime: AgentRuntime = {
  kind: "claude-code",
  run: runClaudeCli,
};

export function extractClaudeCliFinalAnswer(output: string): { text: string; sessionId?: string } {
  let result = "";
  let sessionId: string | undefined;
  const textParts: string[] = [];

  for (const raw of parseJsonObjects(output)) {
    const event = raw as {
      type?: string;
      result?: unknown;
      session_id?: unknown;
      is_error?: unknown;
      error?: unknown;
      message?: { content?: unknown; model?: unknown };
    };

    if (event.type === "result" && typeof event.session_id === "string") {
      sessionId = event.session_id;
    }

    if (event.type === "result") {
      if (event.is_error === true) {
        continue;
      }
      if (typeof event.result === "string") {
        result = event.result;
      }
    }

    if (event.error || event.message?.model === "<synthetic>") {
      continue;
    }

    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const part of event.message.content as Array<{ type?: unknown; text?: unknown }>) {
        if (part.type === "text" && typeof part.text === "string") {
          textParts.push(part.text);
        }
      }
    }
  }

  return { text: (result || textParts.join("\n")).trim(), sessionId };
}

export function extractSessionId(output: string): string | null {
  for (const raw of parseJsonObjects(output)) {
    const event = raw as {
      type?: unknown;
      subtype?: unknown;
      session_id?: unknown;
    };
    if (
      event.type === "system" &&
      event.subtype === "init" &&
      typeof event.session_id === "string"
    ) {
      return event.session_id;
    }
  }
  return null;
}

function createEnv(agentId: AgentId, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    ORBIT_AGENT_ID: agentId,
  };
}

/**
 * Terminate the entire process tree for a given PID.
 * - Windows: Uses taskkill with /T (tree) and /F (force) flags.
 * - Unix: Uses process group termination via negative PID.
 */
export function interruptProcessTree(pid: number): void {
  if (os.platform() === "win32") {
    // Windows: taskkill with /T terminates all child processes
    spawn("taskkill", ["/pid", String(pid), "/F", "/T"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    // Unix: kill process group (negative PID)
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Fallback: direct kill if process group doesn't exist
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process may have already exited
      }
    }
  }
}
