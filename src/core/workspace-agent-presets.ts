import type { AgentConfig, AgentRuntimeKind, RuntimeAvailability } from "../shared/types.ts";
import { AGENT_TEAM_TEMPLATES } from "./agent-config-store.ts";
import { AGENT_RUNTIME_PRIORITY, runtimeKindToCliKey } from "./runtime-meta.ts";

const FALLBACK_RUNTIME: AgentRuntimeKind = "claude-code";

export function preferredRuntimeFromAvailability(availability: readonly RuntimeAvailability[]): AgentRuntimeKind {
  // RuntimeAvailability.runtime holds executable keys ("claude-agent-acp", "codex-acp", "codebuddy"),
  // so we convert AgentRuntimeKind ("claude-code") to CLI key via runtimeKindToCliKey().
  const availableRuntimes = new Set(
    availability
      .filter((item) => item.available)
      .map((item) => item.runtime),
  );
  return AGENT_RUNTIME_PRIORITY.find((runtime) => availableRuntimes.has(runtimeKindToCliKey(runtime))) ?? FALLBACK_RUNTIME;
}

/**
 * 把本地可用的运行时轮流分配给多个数字员工，尽量让团队使用不同的运行时。
 *
 * - 可用运行时按 AGENT_RUNTIME_PRIORITY 排序后作为分配池；
 * - 第 i 个成员使用 pool[i % pool.length]，成员数超过池大小时循环复用；
 * - 没有任何可用运行时（或探测未完成）时回落到 FALLBACK_RUNTIME，全员相同。
 */
export function distributeRuntimesFromAvailability(
  memberCount: number,
  availability: readonly RuntimeAvailability[],
): AgentRuntimeKind[] {
  const pool = AGENT_RUNTIME_PRIORITY.filter((runtime) =>
    availability.some((item) => item.runtime === runtimeKindToCliKey(runtime) && item.available),
  );
  const effectivePool = pool.length > 0 ? pool : [FALLBACK_RUNTIME];
  return Array.from({ length: memberCount }, (_, index) => effectivePool[index % effectivePool.length]);
}

/**
 * 返回按工作区模板预置的数字员工配置。
 *
 * 工作区模板即"数字员工团队预置模板"：模板 id 与 AGENT_TEAM_TEMPLATES 的团队 id 对齐。
 * - 命中团队模板 → 返回该团队全部成员并启用；传入 availability 时按本地实际可用的运行时
 *   轮流分配（尽量让成员使用不同的运行时），未传入则保留模板自带 runtime；
 * - 未命中（如空白工作区）→ 返回 null，表示不预置任何数字员工。
 */
export function initialAgentConfigsForWorkspacePreset(
  presetId: string,
  availability?: readonly RuntimeAvailability[],
): AgentConfig[] | null {
  const template = AGENT_TEAM_TEMPLATES.find((team) => team.id === presetId);
  if (!template) return null;
  if (!availability) {
    return template.members.map((member) => ({ ...member, enabled: true }));
  }
  const runtimes = distributeRuntimesFromAvailability(template.members.length, availability);
  return template.members.map((member, index) => ({ ...member, enabled: true, runtime: runtimes[index] }));
}
