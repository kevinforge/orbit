/**
 * 附件上传生命周期状态机（PR #147 审查修复 M1）。
 *
 * 输入区的附件上传是异步的，而工作区/会话可以在上传期间切换。该状态机
 * 用单调递增的上下文版本把每次上传及其附件槽位绑定到发起时的会话快照：
 * - 切换工作区或会话时 `resetContext()` 递增版本并清空计数，旧请求
 *   的完成回调据此被判定为过期，不会回写新会话的输入区，也不会递减新
 *   会话的上传计数或附件槽位（过期批次的槽位责任已随上下文清零消失，
 *   再次释放会污染新会话的计数、绕过前端附件上限）。
 * - 发送前的权威拦截读取同步的 `uploadingCount`（渲染态仅用于按钮禁用），
 *   保证「上传未完成不允许发送」不依赖 React 渲染时序。
 */

export type AttachmentUploadContext = {
  workspaceId: string;
  conversationId: string;
  /** 上传发起时的上下文版本；`resetContext()` 之后即为过期。 */
  version: number;
};

export function createAttachmentUploadLifecycle() {
  let version = 0;
  let uploadingCount = 0;
  let slotCount = 0;

  return {
    /**
     * 捕获当前上下文快照，占用一个上传计数与 `slots` 个附件槽位
     * （含上传中的文件；上传成功后槽位继续被附件占用）。
     */
    beginUpload(context: { workspaceId: string; conversationId: string }, slots: number): AttachmentUploadContext {
      uploadingCount += 1;
      slotCount += slots;
      return { ...context, version };
    },
    /** 工作区或会话变化时调用：作废所有进行中的上传并清零计数。 */
    resetContext(): void {
      version += 1;
      uploadingCount = 0;
      slotCount = 0;
    },
    /**
     * 为不上传文件的异步操作（删除附件、发送消息）捕获上下文快照：
     * 不占用任何计数，仅用于响应到达时判定是否过期。
     */
    captureContext(context: { workspaceId: string; conversationId: string }): AttachmentUploadContext {
      return { ...context, version };
    },
    /** 上传完成回调是否仍属于当前上下文（过期结果必须丢弃）。 */
    isStale(context: AttachmentUploadContext): boolean {
      return context.version !== version;
    },
    /**
     * 结束一次上传：仅当上下文仍有效时释放上传计数。
     * 过期回调返回 false 且不触碰当前计数，避免旧会话请求污染新会话。
     */
    finishUpload(context: AttachmentUploadContext): boolean {
      if (context.version !== version) return false;
      uploadingCount = Math.max(0, uploadingCount - 1);
      return true;
    },
    /**
     * 释放上传失败的槽位：过期批次的槽位责任已随 `resetContext()` 清零
     * 消失，直接忽略，绝不递减当前会话的槽位。
     */
    releaseSlots(context: AttachmentUploadContext, count = 1): void {
      if (context.version !== version) return;
      slotCount = Math.max(0, slotCount - count);
    },
    /**
     * 删除附件请求确认后释放槽位：请求在途期间切换会话则忽略
     * （该槽位属于发起时的会话，其占用已随上下文清零消失）。
     */
    removeSlot(context: AttachmentUploadContext): boolean {
      if (context.version !== version) return false;
      slotCount = Math.max(0, slotCount - 1);
      return true;
    },
    /**
     * 发送成功后清零槽位：请求在途期间切换会话则忽略，绝不清空
     * 新会话的输入区占用。
     */
    clearSlots(context: AttachmentUploadContext): boolean {
      if (context.version !== version) return false;
      slotCount = 0;
      return true;
    },
    /** 同步上传计数：发送前的权威拦截以此为准。 */
    getUploadingCount(): number {
      return uploadingCount;
    },
    /** 已占用附件槽位（含上传中）：前端附件上限以此判断。 */
    getSlotCount(): number {
      return slotCount;
    },
  };
}

export type AttachmentUploadLifecycle = ReturnType<typeof createAttachmentUploadLifecycle>;
