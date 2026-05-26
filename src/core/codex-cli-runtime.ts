import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentId } from "../shared/types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import { extractReadableText } from "./ansi-text-extractor.ts";

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
  const command = buildCodexCliCommand({ cwd: options.cwd, resumeSessionId: options.resumeSessionId });
  const env = createCodexEnv(options.agentId, options.cwd, options.env ?? process.env);
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
      if (!capturedSessionId) sessionIdResolve(null);

      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Codex CLI exited with code ${code}`));
        return;
      }

      const parsed = extractCodexCliFinalAnswer(stdout);
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

export function buildCodexCliCommand(options: { cwd: string; resumeSessionId?: string }): { file: string; args: string[] } {
  const args = buildCodexCliArgs(options);
  if (os.platform() !== "win32") {
    return { file: "codex", args };
  }

  return { file: "cmd.exe", args: ["/d", "/s", "/c", "codex.cmd", ...args] };
}

export function extractCodexCliFinalAnswer(output: string): { text: string; sessionId?: string } {
  let sessionId: string | undefined;
  const textParts: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const event = JSON.parse(trimmed);
      sessionId ??= sessionIdFromEvent(event) ?? undefined;
      const text = textFromEvent(event);
      if (text) {
        textParts.push(text);
      }
    } catch {
      textParts.push(trimmed);
    }
  }

  return { text: textParts.join("\n").trim(), sessionId };
}

export function extractCodexSessionId(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const sessionId = sessionIdFromEvent(JSON.parse(trimmed));
      if (sessionId) {
        return sessionId;
      }
    } catch {
      // not JSON
    }
  }
  return null;
}

export const codexRuntime: AgentRuntime = {
  kind: "codex",
  run: runCodexCli,
};

export function createCodexEnv(agentId: AgentId, cwd: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sourceHome = resolveCodexSourceHome(env);
  const agentHome = codexHomeForAgent(cwd, agentId);
  prepareCodexHome(sourceHome, agentHome);

  return {
    ...env,
    CODEX_HOME: agentHome,
    ORBIT_AGENT_ID: agentId,
    CODEX_AGENT_ID: agentId,
  };
}

export function codexHomeForAgent(cwd: string, agentId: AgentId): string {
  return path.join(cwd, ".orbit", "runtimes", "codex", sanitizePathSegment(agentId));
}

export function prepareCodexHome(sourceHome: string, targetHome: string): void {
  if (path.resolve(sourceHome) === path.resolve(targetHome)) {
    return;
  }

  fs.mkdirSync(targetHome, { recursive: true });
  for (const fileName of ["auth.json", "config.toml", "AGENTS.md", "installation_id", "version.json"]) {
    copyIfNewer(path.join(sourceHome, fileName), path.join(targetHome, fileName));
  }
}

function resolveCodexSourceHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function copyIfNewer(source: string, target: string): void {
  if (!fs.existsSync(source)) {
    return;
  }

  if (fs.existsSync(target)) {
    const sourceStat = fs.statSync(source);
    const targetStat = fs.statSync(target);
    if (targetStat.mtimeMs >= sourceStat.mtimeMs) {
      return;
    }
  }

  fs.copyFileSync(source, target);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
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
  };

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
    content?: unknown;
    text?: unknown;
  };

  if (message.role !== "assistant" && message.type !== "message" && message.type !== "agent_message") {
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
