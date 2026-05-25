import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";

import type { AgentId } from "../shared/types.ts";
import { extractReadableText } from "./ansi-text-extractor.ts";

export type ClaudeCliRunOptions = {
  agentId: AgentId;
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  env?: NodeJS.ProcessEnv;
  onOutput?: (text: string) => void;
};

export type ClaudeCliRunHandle = {
  process: ChildProcessWithoutNullStreams;
  result: Promise<string>;
  sessionId: Promise<string | null>;
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

export function runClaudeCli(options: ClaudeCliRunOptions): ClaudeCliRunHandle {
  const args = buildClaudeCliArgs({ resumeSessionId: options.resumeSessionId });
  const command = buildClaudeCliCommand(args);
  const child = spawn(command.file, command.args, {
    cwd: options.cwd,
    env: createEnv(options.agentId, options.env ?? process.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
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
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (typeof event.session_id === "string") {
            capturedSessionId = event.session_id;
            sessionIdResolve(capturedSessionId);
          }
        } catch {
          // not JSON, ignore
        }
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
      if (!capturedSessionId) sessionIdResolve(null);

      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Claude CLI exited with code ${code}`));
        return;
      }

      const answer = extractClaudeCliFinalAnswer(stdout);
      if (!answer) {
        reject(new Error("Claude CLI completed without a final answer."));
        return;
      }

      resolve(answer);
    });
  });

  child.stdin.end(options.prompt);
  return { process: child, result, sessionId: sessionIdPromise };
}

export function buildClaudeCliCommand(cliArgs?: string[]): { file: string; args: string[] } {
  const args = cliArgs ?? buildClaudeCliArgs();
  if (os.platform() !== "win32") {
    return { file: "claude", args };
  }

  return { file: "cmd.exe", args: ["/d", "/s", "/c", "claude.cmd", ...args] };
}

export function extractClaudeCliFinalAnswer(output: string): string {
  let result = "";
  const textParts: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        result?: unknown;
        message?: { content?: unknown };
      };

      if (event.type === "result" && typeof event.result === "string") {
        result = event.result;
      }

      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const part of event.message.content as Array<{ type?: unknown; text?: unknown }>) {
          if (part.type === "text" && typeof part.text === "string") {
            textParts.push(part.text);
          }
        }
      }
    } catch {
      textParts.push(trimmed);
    }
  }

  return (result || textParts.join("\n")).trim();
}

export function extractSessionId(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (typeof event.session_id === "string") {
        return event.session_id;
      }
    } catch {
      // not JSON
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
