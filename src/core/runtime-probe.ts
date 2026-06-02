import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { resolveCodexCommand } from "./codex-cli-runtime.ts";

const execFileAsync = promisify(execFile);

export type RuntimeProbeResult = {
  runtime: string;
  available: boolean;
  path: string | null;
  error?: string;
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
  if (!command || !command.trim()) {
    return { runtime: command, available: false, path: null, error: "Empty command name" };
  }
  try {
    const result = await resolveCommand(command);
    if (result.available) {
      return { runtime: command, available: true, path: result.path };
    }
    return { runtime: command, available: false, path: null, error: `Command not found: ${command}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { runtime: command, available: false, path: null, error: message };
  }
}

export type RuntimeAvailabilityMap = Record<string, RuntimeProbeResult>;

/** Map AgentRuntimeKind to CLI probe key: claude-code → claude */
export function runtimeKindToCliKey(runtime: string): string {
  return runtime === "claude-code" ? "claude" : runtime;
}

export async function probeAllRuntimes(): Promise<RuntimeProbeResult[]> {
  return Promise.all([
    probeRuntime("claude"),
    probeCodexRuntime(),
    probeRuntime("codebuddy"),
  ]);
}

async function probeCodexRuntime(): Promise<RuntimeProbeResult> {
  // Use the same resolver as the actual Codex CLI runtime
  const resolved = resolveCodexCommand();
  // If the resolver returned an absolute path, check it exists on disk
  if (resolved !== "codex") {
    // Not the bare fallback — the resolver found a specific installation
    return fs.existsSync(resolved)
      ? { runtime: "codex", available: true, path: resolved }
      : { runtime: "codex", available: false, path: null, error: `Configured path not found: ${resolved}` };
  }
  // Bare "codex" — fall back to PATH probe
  return probeRuntime("codex");
}
