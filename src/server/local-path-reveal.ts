import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RevealResolution =
  | { ok: true; target: string; isDirectory: boolean }
  | { ok: false; status: 400 | 403 | 404; message: string };

// 比较前归一化：统一分隔符、去掉尾部斜杠、转小写（Windows 路径不区分
// 大小写；POSIX 侧小写化只会让比较略偏保守，不会放开边界）。返回给 UI 的
// target 始终保留 fs.realpath 的真实大小写。
function normalizeForCompare(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isInsideWorkspaces(candidate: string, roots: string[]): boolean {
  const normalized = normalizeForCompare(candidate);
  return roots.some((root) => {
    const base = normalizeForCompare(root);
    if (!base) return false;
    return normalized === base || normalized.startsWith(`${base}/`);
  });
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return null;
  }
}

export async function resolveRevealTarget(rawPath: string, roots: string[]): Promise<RevealResolution> {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { ok: false, status: 400, message: "path is required." };
  }
  let candidate = rawPath.trim();
  if (candidate === "~") {
    candidate = os.homedir();
  } else if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  }
  let resolved = await realpathOrNull(candidate);
  if (!resolved) {
    // 源码引用常带 :line 或 :line:col 后缀（styles.css:5127），realpath 失败
    // 时剥掉后缀重试，让入口仍能定位到文件本身。
    const withoutLine = candidate.replace(/:\d+(?::\d+)?$/, "");
    if (withoutLine !== candidate) {
      resolved = await realpathOrNull(withoutLine);
    }
  }
  if (!resolved) {
    return { ok: false, status: 404, message: `路径不存在：${candidate}` };
  }
  // 默认决策 D2：仅允许定位到已配置工作区内的路径，防止消息内容把资源
  // 管理器指向任意本机目录（issue #143）。
  if (!isInsideWorkspaces(resolved, roots)) {
    return {
      ok: false,
      status: 403,
      message: "该路径不在任何已配置的工作区内，出于安全考虑不在资源管理器中打开。",
    };
  }
  const stats = await fs.promises.stat(resolved);
  return { ok: true, target: resolved, isDirectory: stats.isDirectory() };
}

export async function revealInFileManager(target: string, isDirectory: boolean): Promise<void> {
  if (process.platform === "win32") {
    try {
      if (isDirectory) {
        await execFileAsync("explorer", [target]);
      } else {
        await execFileAsync("explorer", [`/select,${target}`]);
      }
    } catch (err) {
      // explorer.exe 即使成功打开窗口也常以退出码 1 结束，这里不能据此报错。
      const code = (err as { code?: number | string } | null)?.code;
      if (code !== 1) throw err;
    }
    return;
  }
  if (process.platform === "darwin") {
    await execFileAsync("open", isDirectory ? [target] : ["-R", target]);
    return;
  }
  await execFileAsync("xdg-open", [isDirectory ? target : path.dirname(target)]);
}
