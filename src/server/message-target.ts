export type MessageTargetInput = {
  workspaceId?: unknown;
  conversationId?: unknown;
};

export type MessageTargetResolution =
  | { ok: true; workspaceId: string; conversationId: string | null }
  | { ok: false; status: number; message: string };

/**
 * 解析消息发送目标（PR #147 M1）。
 *
 * - 字段缺失（`undefined`，旧调用兼容）回退请求入口快照的 active 会话。
 * - 显式传入空串或非字符串一律 400 拒绝，绝不静默改投其他会话。
 * - 显式 workspaceId/conversationId 必须真实存在，否则 404。
 * - `conversationId: null` 表示无目标会话（合法的首条消息场景，由调用方
 *   在解析出的工作区内新建）。
 */
export function resolveMessageTarget(
  input: MessageTargetInput,
  entry: { workspaceId: string; conversationId: string },
  exists: {
    workspace(workspaceId: string): boolean;
    conversation(workspaceId: string, conversationId: string): boolean;
  },
): MessageTargetResolution {
  if (input.workspaceId !== undefined && (typeof input.workspaceId !== "string" || input.workspaceId === "")) {
    return { ok: false, status: 400, message: "workspaceId must be a non-empty string when provided." };
  }
  if (input.conversationId !== undefined && (typeof input.conversationId !== "string" || input.conversationId === "")) {
    return { ok: false, status: 400, message: "conversationId must be a non-empty string when provided." };
  }

  const explicitWorkspaceId = typeof input.workspaceId === "string" ? input.workspaceId : null;
  const explicitConversationId = typeof input.conversationId === "string" ? input.conversationId : null;
  const workspaceId = explicitWorkspaceId ?? entry.workspaceId;

  if (!workspaceId) {
    return { ok: false, status: 409, message: "Create or select a workspace before sending a message." };
  }
  if (explicitWorkspaceId && !exists.workspace(workspaceId)) {
    return { ok: false, status: 404, message: "Workspace not found." };
  }
  if (explicitConversationId && !exists.conversation(workspaceId, explicitConversationId)) {
    return { ok: false, status: 404, message: "Conversation not found." };
  }

  return {
    ok: true,
    workspaceId,
    conversationId: explicitConversationId ?? (entry.conversationId || null),
  };
}
