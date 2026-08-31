/**
 * 上传前的会话补建（PR #147 审查修复）。
 *
 * 上传目标由 `workspaceId + conversationId` 决定（草稿就存在这个目录下），
 * 服务端要求会话已存在，否则返回 409。而切换工作区后 active 会话为空，
 * 于是"新工作区第一条消息就是附件"这个场景直接不可用。这里在上传前补建
 * 一个会话：与 `saveSupervisorConfig`、`selectInteractionMode` 的既有做法
 * 一致，且不在服务端惰性建会话——只上传不发送会留下空会话记录。
 *
 * 抽成独立函数是为了脱离 React 环境做行为测试。
 */
export async function createConversationForUpload(
  workspaceId: string,
  request: (url: string, init: RequestInit) => Promise<Response>,
): Promise<string> {
  if (!workspaceId) throw new Error("请先选择或创建工作区，再添加附件。");

  const response = await request(
    `/api/conversations?workspaceId=${encodeURIComponent(workspaceId)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  const created = await response.json().catch(() => ({})) as { id?: unknown; message?: unknown };
  const conversationId = typeof created.id === "string" ? created.id.trim() : "";
  if (!response.ok || !conversationId) {
    throw new Error(
      typeof created.message === "string" && created.message
        ? created.message
        : "创建会话失败，无法添加附件。",
    );
  }
  return conversationId;
}
