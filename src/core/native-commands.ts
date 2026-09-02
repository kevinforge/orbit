import type { AgentCommand, AgentId, InteractionMode } from "../shared/types.ts";
import { matchAssignmentPrefix } from "./mention-router.ts";

/**
 * 解析原生斜杠命令的目标员工（issue #160）：显式 `@员工:` 前缀唯一命中
 * 已启用员工时命令直达该员工，各协作模式一致（与指派路由对显式标记的
 * 走向相同）；无前缀时沿用普通对话走向——直接协作发给最近直接对话员工，
 * 简单/复杂协作没有默认接收方，不提供原生命令入口。
 *
 * 服务端发送入口与 UI 菜单共用本模块：频道历史里的 content 是唯一输入，
 * 实际发给 runtime 的命令文本由这里推导，两者不可能再分叉。
 */
export function resolveSlashCommandTarget(
  trimmed: string,
  interactionMode: InteractionMode,
  lastDirectAgentId: string | undefined,
  agents: readonly { id: AgentId; label: string }[],
): { agentId: AgentId; commandText: string } | null {
  // 与指派路由共用同一套标记语义（mention-router）：全角冒号也算标记结束，
  // 名称匹配忽略大小写；前缀必须唯一命中已启用员工才提供命令入口。
  const prefix = matchAssignmentPrefix(trimmed);
  if (prefix) {
    const label = prefix.name.toLocaleLowerCase();
    const matches = agents.filter((agent) => agent.label.toLocaleLowerCase() === label);
    return matches.length === 1
      ? { agentId: matches[0]!.id, commandText: trimmed.slice(prefix.end) }
      : null;
  }
  if (interactionMode !== "direct" || !lastDirectAgentId) {
    return null;
  }
  return { agentId: lastDirectAgentId, commandText: trimmed };
}

/**
 * 判断待发送文本是否按原生斜杠命令投递（issue #160）：命令词是目标员工
 * runtime 会话已通告的命令时返回目标员工与命令文本，否则按普通消息走路由。
 * 命令快照由调用方从权威来源传入（UI 传 agentCommands 状态，服务端传
 * availableCommands()）。
 */
export function resolveSlashSendTarget(
  trimmed: string,
  interactionMode: InteractionMode,
  lastDirectAgentId: string | undefined,
  agents: readonly { id: AgentId; label: string }[],
  agentCommands: Record<AgentId, readonly AgentCommand[]>,
): { agentId: AgentId; commandText: string } | null {
  const resolved = resolveSlashCommandTarget(trimmed, interactionMode, lastDirectAgentId, agents);
  if (!resolved || !resolved.commandText.startsWith("/")) {
    return null;
  }
  const name = resolved.commandText.split(/\s+/)[0]?.slice(1) ?? "";
  const available = agentCommands[resolved.agentId] ?? [];
  return available.some((command) => command.name === name) ? resolved : null;
}
