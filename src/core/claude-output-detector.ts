/**
 * Lightweight structural guard: rejects outputs that are clearly not final answers.
 *
 * After parseJsonObjects + textFromEvent correctly extract only agent_message / result
 * text from the structured event stream, the output should be pure markdown text.
 * This guard catches the two structural leakage patterns that would survive extraction:
 * 1. Raw JSON events (parseJsonObjects filter gap)
 * 2. CLI shell prompts (stdout mix-in)
 *
 * No keyword blacklist — extraction correctness is the real defense.
 */
export function isCleanFinalAnswer(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) {
    return false;
  }

  // Raw JSON event leakage — the text starts like a JSON object
  if (/^\{\s*"type"\s*:/.test(trimmed)) {
    return false;
  }

  // CLI shell prompt leakage
  if (/^>/.test(trimmed)) {
    return false;
  }

  return true;
}
