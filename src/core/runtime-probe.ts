import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveClaudeAcpCommand } from "./claude-acp-runtime.ts";
import { resolveCodexAcpCommand } from "./codex-acp-runtime.ts";

// Re-export from shared browser-safe module
export { runtimeKindToCliKey, runtimeMeta, type RuntimeMeta } from "./runtime-meta.ts";

const execFileAsync = promisify(execFile);

export type RuntimeProbeResult = {
  runtime: string;
  available: boolean;
  path: string | null;
  error?: string;
  checkedAt: string;
};

const TIMEOUT_MS = 5000;

async function resolveCommand(command: string): Promise<{ available: boolean; path: string | null }> {
  try {
    // On Windows, use `where`; on Unix, use `which`
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("where", [command], { timeout: TIMEOUT_MS, windowsHide: true });
      const firstLine = stdout.split("\r\n")[0]?.trim() ?? "";
      if (firstLine) {
        return { available: true, path: firstLine };
      }
    } else {
      const { stdout } = await execFileAsync("which", [command], { timeout: TIMEOUT_MS });
      const resolved = stdout.trim();
      if (resolved) {
        return { available: true, path: resolved };
      }
    }
    return { available: false, path: null };
  } catch {
    return { available: false, path: null };
  }
}

export async function probeRuntime(command: string): Promise<RuntimeProbeResult> {
  const checkedAt = new Date().toISOString();
  if (!command || !command.trim()) {
    return { runtime: command, available: false, path: null, error: "Empty command name", checkedAt };
  }
  try {
    const result = await resolveCommand(command);
    if (result.available) {
      return { runtime: command, available: true, path: result.path, checkedAt };
    }
    return { runtime: command, available: false, path: null, error: `Command not found: ${command}`, checkedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { runtime: command, available: false, path: null, error: message, checkedAt };
  }
}

export type RuntimeAvailabilityMap = Record<string, RuntimeProbeResult>;

export async function probeAllRuntimes(): Promise<RuntimeProbeResult[]> {
  return Promise.all([
    probeClaudeAcpRuntime(),
    probeCodexAcpRuntime(),
    probeRuntime("codebuddy"),
  ]);
}

async function probeClaudeAcpRuntime(): Promise<RuntimeProbeResult> {
  const checkedAt = new Date().toISOString();
  const resolved = resolveClaudeAcpCommand();
  if (path.isAbsolute(resolved)) {
    return fs.existsSync(resolved)
      ? { runtime: "claude-agent-acp", available: true, path: resolved, checkedAt }
      : { runtime: "claude-agent-acp", available: false, path: null, error: `Configured path not found: ${resolved}`, checkedAt };
  }
  const result = await probeRuntime(resolved);
  return { ...result, runtime: "claude-agent-acp" };
}

async function probeCodexAcpRuntime(): Promise<RuntimeProbeResult> {
  const checkedAt = new Date().toISOString();
  const resolved = resolveCodexAcpCommand();
  if (path.isAbsolute(resolved)) {
    return fs.existsSync(resolved)
      ? { runtime: "codex-acp", available: true, path: resolved, checkedAt }
      : { runtime: "codex-acp", available: false, path: null, error: `Configured path not found: ${resolved}`, checkedAt };
  }
  const result = await probeRuntime(resolved);
  return { ...result, runtime: "codex-acp" };
}
