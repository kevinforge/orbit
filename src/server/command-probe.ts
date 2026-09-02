import { probeAcpCommands, type AcpRuntimeDefinition } from "../core/acp-runtime.ts";
import type { AgentCommand, AgentCommandsSnapshot, AgentId, RuntimeEvent } from "../shared/types.ts";

export type CommandProbeEvent = Extract<RuntimeEvent, { type: "agent.commands.updated" }>;

/**
 * probeAgentCommands 需要的会话命令视图：真实调用方是 ConversationContext，
 * 行为测试可以直接用 AgentRegistry 或受控替身实现同一窄接口。
 */
export type CommandProbeTarget = {
  availableCommands(): Record<AgentId, readonly AgentCommand[]>;
  adoptProbedCommands(agentId: AgentId, commands: readonly AgentCommand[]): boolean;
  hasRuntimeSessionCommands(agentId: AgentId): boolean;
};

export type CommandProbeDeps = {
  /** 传输层广播（index.ts 注入 sseHub.publish），测试据此断言广播内容。 */
  publish: (event: CommandProbeEvent) => void;
  /** 命令探测入口，测试注入受控 Promise 制造“探测途中正式通告先到”。 */
  probe?: typeof probeAcpCommands;
  warn?: (message: string, detail: string) => void;
};

/**
 * 为员工拉一次斜杠命令快照并按会话广播（issue #160 收尾）。会话里已有通告
 * （runtime 通告或上次探测写回，含空列表）时直接复用，不重复拉起 runtime
 * 进程；探测成功写回会话缓存——/api/state、探测短路和发送校验共用这一份
 * 权威快照，探测出的命令才能直接发送。探测失败同样以 error 快照广播，让
 * UI 停在明确的失败态（可重试），而不是“输入 / 毫无反应”。
 *
 * 探测是异步的，期间员工的正式会话可能建立并通告真实命令：写回被拒时
 * 不得广播探测结果，探测失败也不得广播 error——两者都以权威快照作答，
 * SSE 与 HTTP 响应都绝不覆盖正式通告。写回、判断与广播之间没有 await，
 * 与正式通告（同步 publish）之间不存在交错窗口。
 */
export async function probeAgentCommands(
  target: CommandProbeTarget | null,
  workspaceId: string,
  conversationId: string,
  agentId: AgentId,
  definition: AcpRuntimeDefinition,
  workspacePath: string,
  deps: CommandProbeDeps,
): Promise<AgentCommandsSnapshot> {
  const existing = target?.availableCommands()[agentId];
  if (existing) {
    return { status: "ready", commands: existing };
  }
  try {
    const commands = await (deps.probe ?? probeAcpCommands)(definition, { agentId, cwd: workspacePath });
    if (!(target?.adoptProbedCommands(agentId, commands) ?? true)) {
      // 正式通告先到：它已经自己广播过，这里静默改答权威快照。
      return { status: "ready", commands: target?.availableCommands()[agentId] ?? commands };
    }
    deps.publish({
      type: "agent.commands.updated",
      workspaceId,
      conversationId,
      agentId,
      commands,
      status: "ready",
    });
    return { status: "ready", commands };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.split("\n")[0]?.trim() || "获取斜杠命令失败。";
    const warn = deps.warn ?? ((detail: string, rawDetail: string) => console.warn(detail, rawDetail));
    warn(`[orbit] slash-command discovery failed for ${definition.displayName}:`, raw);
    if (target?.hasRuntimeSessionCommands(agentId)) {
      return { status: "ready", commands: target.availableCommands()[agentId] ?? [] };
    }
    deps.publish({
      type: "agent.commands.updated",
      workspaceId,
      conversationId,
      agentId,
      commands: [],
      status: "error",
      message,
    });
    return { status: "error", commands: [], message };
  }
}
