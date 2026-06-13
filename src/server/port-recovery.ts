import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PortOwner = {
  pid: number;
  command?: string;
};

type ExecFileLike = (file: string, args: string[]) => Promise<{ stdout: string }>;

export async function findPortOwners(port: number, exec: ExecFileLike = execFileAsync): Promise<PortOwner[]> {
  if (process.platform === "win32") {
    return findWindowsPortOwners(port, exec);
  }
  return findUnixPortOwners(port, exec);
}

export function isOrbitPortOwner(owner: PortOwner): boolean {
  const command = (owner.command ?? "").toLowerCase();
  return /\borbit(\.exe)?\b/.test(command) || command.includes("\\orbit\\") || command.includes("/orbit/");
}

export async function stopPortOwner(owner: PortOwner): Promise<void> {
  process.kill(owner.pid, process.platform === "win32" ? undefined : "SIGTERM");
}

async function findWindowsPortOwners(port: number, exec: ExecFileLike): Promise<PortOwner[]> {
  const { stdout } = await exec("netstat.exe", ["-ano", "-p", "tcp"]);
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    if (!localAddressMatchesPort(parts[1], port)) continue;
    const pid = Number(parts[4]);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }

  const owners: PortOwner[] = [];
  for (const pid of pids) {
    owners.push({ pid, command: await readWindowsCommandLine(pid, exec) });
  }
  return owners;
}

async function readWindowsCommandLine(pid: number, exec: ExecFileLike): Promise<string | undefined> {
  try {
    const { stdout } = await exec("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
    ]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function findUnixPortOwners(port: number, exec: ExecFileLike): Promise<PortOwner[]> {
  try {
    const { stdout } = await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    const owners: PortOwner[] = [];
    for (const line of stdout.split(/\r?\n/).slice(1)) {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[1]);
      if (Number.isInteger(pid) && pid > 0) {
        owners.push({ pid, command: parts[0] });
      }
    }
    return dedupeOwners(owners);
  } catch {
    return [];
  }
}

function localAddressMatchesPort(address: string, port: number): boolean {
  return address.endsWith(`:${port}`);
}

function dedupeOwners(owners: PortOwner[]): PortOwner[] {
  const seen = new Set<number>();
  return owners.filter((owner) => {
    if (seen.has(owner.pid)) return false;
    seen.add(owner.pid);
    return true;
  });
}
