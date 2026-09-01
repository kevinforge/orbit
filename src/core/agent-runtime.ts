import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  AgentActivityEvent,
  AgentCommand,
  AgentId,
  AgentModelStateSnapshot,
  AgentPermissionRequest,
  AgentRuntimeKind,
  AgentElicitationRequest,
  ApprovalMode,
  ElicitationResponse,
  MessageAttachment,
  PermissionDecision,
} from "../shared/types.ts";

export class AgentRunCancelledError extends Error {
  readonly userMessage: string;

  constructor(message: string, userMessage = "运行已取消。") {
    super(message);
    this.name = "AgentRunCancelledError";
    this.userMessage = userMessage;
  }
}

export function isAgentRunCancelledError(error: unknown): error is AgentRunCancelledError {
  return error instanceof AgentRunCancelledError;
}

export type AgentRuntimeRunOptions = {
  agentId: AgentId;
  prompt: string;
  cwd: string;
  approvalMode?: ApprovalMode;
  requestPermission?: (request: AgentPermissionRequest) => Promise<PermissionDecision>;
  requestElicitation?: (request: AgentElicitationRequest) => Promise<ElicitationResponse>;
  resumeSessionId?: string;
  env?: NodeJS.ProcessEnv;
  onOutput?: (text: string) => void;
  onActivity?: (activity: AgentActivityEvent) => void;
  /**
   * 服务端已固化的完整附件元数据（MessageAttachment）。runtime 据此组装
   * ACP 内容块：图片能力开启时图片走原生 image，其余一律 resource_link。
   */
  attachments?: readonly MessageAttachment[];
  /** Stable owner key used to prevent ACP process reuse across conversations. */
  poolKey?: string;
  /** 员工首选模型 ID（issue #142）：会话建立后、prompt 前尽力应用，失败只提示。 */
  preferredModelId?: string;
  /** 该员工最近一次的模型快照；池复用连接没有响应可读时用它补发偏好。 */
  lastSessionConfig?: AgentModelStateSnapshot;
  /** 模型快照回调：runtime 返回或切换后携带最新模型列表与当前值。 */
  onSessionConfig?: (snapshot: AgentModelStateSnapshot) => void;
  /**
   * 斜杠命令回调（issue #160）：runtime 会话通告 ACP
   * `available_commands_update` 时携带完整命令列表与会话 ID。
   */
  onSessionCommands?: (commands: readonly AgentCommand[], sessionId: string) => void;
};

export type AgentRuntimeRunHandle = {
  process: {
    kill: () => void;
    pid: number;
    /** Request cancellation; ACP runtimes may terminate the process tree as a fallback. */
    interrupt: () => void;
  };
  result: Promise<string>;
  sessionId: Promise<string | null>;
};

export interface AgentRuntime {
  readonly kind: AgentRuntimeKind;
  readonly transport?: "cli" | "acp";
  readonly protocolVersion?: number;
  run(input: AgentRuntimeRunOptions): AgentRuntimeRunHandle;
}
