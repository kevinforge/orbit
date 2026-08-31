/**
 * 页面上下文解析（PR #147 审查修复）。
 *
 * 抽出来是为了让"没有会话"与"会话不存在"能被区分：此前 `resolveTarget`
 * 对两者都返回 null，调用方只能统一报 409 "No active conversation."，与
 * `/api/messages` 对未知会话返回 404 的语义不一致。
 */

export type RequestTarget = { workspaceId: string; conversationId: string };

export type TargetMissingReason =
  | "missing_workspace"
  | "missing_conversation"
  | "unknown_conversation";

export type TargetResolution =
  | { target: RequestTarget; reason: null }
  | { target: null; reason: TargetMissingReason };

export type TargetLookupState = {
  activeWorkspaceId: string;
  activeConversationId: string;
};

export type TargetLookupExists = {
  workspace: (workspaceId: string) => boolean;
  conversation: (workspaceId: string, conversationId: string) => boolean;
};

/**
 * Query 参数是公开契约；active 指针只为旧客户端与重启恢复保留。
 */
export function resolveTargetIds(
  url: URL,
  state: TargetLookupState,
  exists: TargetLookupExists,
  requireConversation = true,
): TargetResolution {
  const workspaceParam = url.searchParams.get("workspaceId");
  const workspaceId = workspaceParam === null ? state.activeWorkspaceId : workspaceParam.trim();
  if (!workspaceId || !exists.workspace(workspaceId)) {
    return { target: null, reason: "missing_workspace" };
  }
  const conversationParam = url.searchParams.get("conversationId");
  const conversationId = conversationParam === null
    ? (workspaceId === state.activeWorkspaceId ? state.activeConversationId : "")
    : conversationParam.trim();
  if (!requireConversation) return { target: { workspaceId, conversationId }, reason: null };
  if (!conversationId) {
    return { target: null, reason: "missing_conversation" };
  }
  if (!exists.conversation(workspaceId, conversationId)) {
    return { target: null, reason: "unknown_conversation" };
  }
  return { target: { workspaceId, conversationId }, reason: null };
}
