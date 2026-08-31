/** Whether a message has user-visible content or at least one attachment. */
export function canSendMessage(content: string, attachmentCount: number): boolean {
  return content.trim().length > 0 || attachmentCount > 0;
}
