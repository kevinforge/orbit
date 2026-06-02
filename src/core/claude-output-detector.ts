const finalAnswerRejectPattern =
  /\b(?:API\s*Error|Stop\s*hook\s*error|UserPromptSubmit\s*hook\s*error|Brewing|Brewed\s*for|Twisting|Fiddle|Synthesizing|bypasspermissions|MCP\s*server\s*failed|tool\.started|tool\.completed|tool\.failed|item\.started|item\.completed)\b|\{"type"\s*:\s*"/i;

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
