/**
 * 请求入口快照 vs 实时 active 指针的判定（PR #147 M1）。
 *
 * 消息发送目标自 #155 起统一从请求 query 参数解析（页面上下文契约）；
 * 本模块判定异步请求新建的会话能否写回 active 指针（compare-and-set）。
 */

/**
 * 新建会话能否写回 active 指针（compare-and-set，PR #147 M1）。
 *
 * 仅当实时 active 工作区与会话仍分别等于请求入口快照——即读取请求体等
 * await 期间用户没有做过任何切换——时才允许写回。否则跳过：新会话照常
 * 创建、消息/响应照常投递，只是不动 active 指针，不打断用户已切换到的
 * 会话。调用方如需将写回限定在入口工作区（隐式新建场景），自行叠加
 * 工作区一致性条件。
 */
export function shouldPromoteNewConversation(
  entry: { workspaceId: string; conversationId: string },
  live: { workspaceId: string; conversationId: string },
): boolean {
  return live.workspaceId === entry.workspaceId && live.conversationId === entry.conversationId;
}
