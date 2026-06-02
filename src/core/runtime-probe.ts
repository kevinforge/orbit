import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

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

/**
 * Probe for codex using the same resolution logic as the Codex CLI runtime
 * (ORBIT_CODEX_PATH, CODEX_CLI_PATH, Windows install locations, PATH fallback).
 */
export function resolveCodexCommandPath(env: NodeJS.ProcessEnv = process.env): string | null {
  // 1. Explicit env var overrides
  const configured = env.ORBIT_CODEX_PATH || env.CODEX_CLI_PATH;
  if (configured) {
    // Absolute paths must exist; relative/bare names are trusted (spawn resolves via PATH)
    if (path.isAbsolute(configured)) {
      return fs.existsSync(configured) ? configured : null;
    }
    return configured;
  }

  if (process.platform !== "win32") {
    // On Unix: PATH-only (checked via exec in probe, not fs)
    return null;
  }

  // 2. Windows: search known install locations
  const candidates = resolveWindowsCodexCommand(env);
  return candidates[0] ?? null;
}

function resolveWindowsCodexCommand(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];

  // OpenAI Codex install directory
  const codexBin = env.LOCALAPPDATA ? [env.LOCALAPPDATA, "OpenAI", "Codex", "bin"].join(String.fromCharCode(92)) : "";
  if (codexBin && fs.existsSync(codexBin)) {
    try {
      const files = fs.readdirSync(codexBin).map((f) => [codexBin, f].join(String.fromCharCode(92)));
      candidates.push(...files.filter((f) => f.toLowerCase().endsWith("codex.exe")));
    } catch { /* ignore read errors */ }
  }

  // Standalone releases directory
  const releasesDir = [env.USERPROFILE ?? "", ".codex", "packages", "standalone", "releases"].join(String.fromCharCode(92));
  if (fs.existsSync(releasesDir)) {
    try {
      for (const entry of fs.readdirSync(releasesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const exe = [releasesDir, entry.name, "codex.exe"].join(String.fromCharCode(92));
          if (fs.existsSync(exe)) candidates.push(exe);
        }
      }
    } catch { /* ignore read errors */ }
  }

  // PATH-based candidates (excluding WindowsApps)
  const pathValue = env.PATH || env.Path || "";
  for (const dir of pathValue.split(";").filter(Boolean)) {
    if (dir.toLowerCase().includes("\\windowsapps")) continue;
    const cmd = [dir, "codex.cmd"].join(String.fromCharCode(92));
    const exe = [dir, "codex.exe"].join(String.fromCharCode(92));
    if (fs.existsSync(cmd)) candidates.push(cmd);
    if (fs.existsSync(exe)) candidates.push(exe);
  }

  return candidates;
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
  // First check full resolution (env vars, known install dirs)
  const resolved = resolveCodexCommandPath();
  if (resolved) {
    return { runtime: "codex", available: true, path: resolved };
  }
  // Fall back to PATH-based probe
  return probeRuntime("codex");
}
