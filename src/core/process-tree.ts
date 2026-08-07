import { spawn } from "node:child_process";
import os from "node:os";

/** Terminate a child process and every process it started. */
export function interruptProcessTree(pid: number): void {
  if (os.platform() === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/F", "/T"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may have already exited.
    }
  }
}
