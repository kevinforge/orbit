import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentId } from "../shared/types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import { extractReadableText } from "./ansi-text-extractor.ts";
import { parseJsonObjects } from "./json-stream-parser.ts";

export type CodexCliRunOptions = {
  agentId: AgentId;
  cwd: string;
  prompt: string;
  permissionProfile?: unknown;
  resumeSessionId?: string;
  env?: NodeJS.ProcessEnv;
  onOutput?: (text: string) => void;
};

export type CodexCliRunHandle = {
  process: ChildProcessWithoutNullStreams;
  result: Promise<string>;
  sessionId: Promise<string | null>;
};

export function buildCodexCliArgs(options: { cwd: string; resumeSessionId?: string }): string[] {
  if (options.resumeSessionId) {
    return [
      "exec",
      "resume",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      options.resumeSessionId,
      "-",
    ];
  }

  return [
    "exec",
    "--json",
    "--cd",
    options.cwd,
    "--sandbox",
    "danger-full-access",
    "--dangerously-bypass-approvals-and-sandbox",
    "-",
  ];
}

export function runCodexCli(options: CodexCliRunOptions): CodexCliRunHandle {
  const command = buildCodexCliCommand(
    { cwd: options.cwd, resumeSessionId: options.resumeSessionId },
    options.env ?? process.env,
  );
  const env = createCodexEnv(options.agentId, options.env ?? process.env);
  const child = spawn(command.file, command.args, {
    cwd: options.cwd,
    env,
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
      const sessionId = extractCodexSessionId(chunk);
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
        reject(new Error(stderr.trim() || stdout.trim() || `Codex CLI exited with code ${code}`));
        return;
      }

      const parsed = extractCodexCliFinalAnswer(stdout);
      if (!capturedSessionId && parsed.sessionId) {
        capturedSessionId = parsed.sessionId;
        sessionIdResolve(parsed.sessionId);
      }
      if (!capturedSessionId) sessionIdResolve(null);

      if (!parsed.text) {
        reject(new Error("Codex CLI completed without a final answer."));
        return;
      }

      resolve(parsed.text);
    });
  });

  child.stdin.end(options.prompt);
  return { process: child, result, sessionId: sessionIdPromise };
}

export function buildCodexCliCommand(
  options: { cwd: string; resumeSessionId?: string },
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  const args = buildCodexCliArgs(options);
  return { file: resolveCodexCommand(env), args };
}

export function extractCodexCliFinalAnswer(output: string): { text: string; sessionId?: string } {
  let sessionId: string | undefined;
  let taskCompleteMessage: string | undefined;
  const textParts: string[] = [];

  for (const event of parseJsonObjects(output)) {
    sessionId ??= sessionIdFromEvent(event) ?? undefined;

    // Priority 1: task_complete.payload.last_agent_message
    const taskMsg = lastAgentMessageFromTaskComplete(event);
    if (taskMsg) {
      taskCompleteMessage = taskMsg;
    }

    // Priority 2: only non-commentary events (final_answer or no phase)
    const text = textFromEvent(event);
    if (text) {
      textParts.push(text);
    }
  }

  // Use task_complete message if available, otherwise fall back to filtered events
  const text = taskCompleteMessage ?? textParts.join("\n").trim();
  return { text, sessionId };
}

export function extractCodexSessionId(output: string): string | null {
  for (const event of parseJsonObjects(output)) {
    const sessionId = sessionIdFromEvent(event);
    if (sessionId) {
      return sessionId;
    }
  }
  return null;
}

export const codexRuntime: AgentRuntime = {
  kind: "codex",
  run: runCodexCli,
};

export function createCodexEnv(agentId: AgentId, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    ORBIT_AGENT_ID: agentId,
    CODEX_AGENT_ID: agentId,
  };
}

export function resolveCodexCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ORBIT_CODEX_PATH || env.CODEX_CLI_PATH;
  if (configured) {
    return configured;
  }

  if (os.platform() !== "win32") {
    return "codex";
  }

  return resolveWindowsCodexCommand(env) ?? "codex";
}

function resolveWindowsCodexCommand(env: NodeJS.ProcessEnv): string | null {
  const candidates = [
    ...codexExecutablesIn(path.join(env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin")),
    ...codexExecutablesIn(path.join(env.USERPROFILE ?? os.homedir(), ".codex", "packages", "standalone", "releases")),
    ...codexCommandsOnPath(env.PATH ?? env.Path ?? ""),
  ];
  return candidates[0] ?? null;
}

function codexExecutablesIn(baseDir: string): string[] {
  if (!baseDir || !fs.existsSync(baseDir)) {
    return [];
  }

  return fs.readdirSync(baseDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase() === "codex.exe")
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function codexCommandsOnPath(pathValue: string): string[] {
  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .filter((dir) => !dir.toLowerCase().includes(`${path.sep.toLowerCase()}windowsapps`))
    .flatMap((dir) => [path.join(dir, "codex.cmd"), path.join(dir, "codex.exe")])
    .filter((candidate) => fs.existsSync(candidate));
}

function sessionIdFromEvent(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const record = event as {
    thread_id?: unknown;
    session_id?: unknown;
    conversation_id?: unknown;
  };

  if (typeof record.thread_id === "string") return record.thread_id;
  if (typeof record.session_id === "string") return record.session_id;
  if (typeof record.conversation_id === "string") return record.conversation_id;
  return null;
}

function lastAgentMessageFromTaskComplete(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as { type?: unknown; payload?: unknown };
  if (record.type !== "task_complete" || !record.payload || typeof record.payload !== "object") return null;
  const payload = record.payload as { last_agent_message?: unknown };
  if (typeof payload.last_agent_message === "string" && payload.last_agent_message.trim()) {
    return payload.last_agent_message.trim();
  }
  return null;
}

function textFromEvent(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "";
  }

  const record = event as {
    type?: unknown;
    item?: unknown;
    message?: unknown;
    content?: unknown;
    text?: unknown;
    result?: unknown;
    is_error?: unknown;
  };

  if (record.is_error === true) {
    return "";
  }

  if (record.type === "result" && typeof record.result === "string") {
    return record.result;
  }

  if (typeof record.text === "string") {
    return record.text;
  }

  return [
    textFromMessage(record.item),
    textFromMessage(record.message),
    textFromContent(record.content),
  ].filter(Boolean).join("\n");
}

function textFromMessage(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const message = value as {
    role?: unknown;
    type?: unknown;
    phase?: unknown;
    content?: unknown;
    text?: unknown;
  };

  if (message.role !== "assistant" && message.type !== "message" && message.type !== "agent_message") {
    return "";
  }

  // Skip commentary phase events — these are intermediate reasoning, not final answers
  if (message.phase === "commentary") {
    return "";
  }

  if (typeof message.text === "string") {
    return message.text;
  }

  return textFromContent(message.content);
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const contentPart = part as { type?: unknown; text?: unknown };
      if (
        (contentPart.type === "text" || contentPart.type === "output_text") &&
        typeof contentPart.text === "string"
      ) {
        return contentPart.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
