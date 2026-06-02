const finalAnswerRejectPattern =
  /\b(?:API Error|Stop hook error|UserPromptSubmit hook error|Brewing|Brewed for|Twisting|Fiddle|Synthesizing|bypasspermissions|MCP server failed)\b/i;

export function isCleanFinalAnswer(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) {
    return false;
  }

  if (finalAnswerRejectPattern.test(trimmed)) {
    return false;
  }

  if (/^>/.test(trimmed)) {
    return false;
  }

  return true;
}
