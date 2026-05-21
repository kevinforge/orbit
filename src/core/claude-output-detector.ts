import { extractReadableText } from "./ansi-text-extractor.ts";

const tuiNoiseMarkers = [
  "Brewing",
  "Brewed for",
  "Ran 3 stop hooks",
  "Ran 4 stop hooks",
  "Stop hook error",
  "Stophookerror",
  "running sp hooks",
  "thinking",
  "bypasspermissions",
  "shift+tab",
  "esc to interrupt",
  "UserPromptSubmit hook error",
  "Failed with non-blocking status code",
];

const inlineTuiMarkerPattern = /\b(?:Brewing|Brewed for|Twisting|Synthesizing|UserPromptSubmit hook error)\b/i;

export function hasClaudeTurnFinished(output: string): boolean {
  return /Brewed for \d+s/i.test(output) || /Stop\s*hook\s*error\s*occurred/i.test(output);
}

export function shouldCompleteFromTerminalOutput(output: string, isQuiet: boolean, stopHookEnabled: boolean): boolean {
  if (stopHookEnabled) {
    return isQuiet;
  }

  return hasClaudeTurnFinished(output) || isQuiet;
}

export function extractClaudeAssistantReply(output: string): string {
  const readable = extractReadableText(output);
  const bulletIndex = readable.lastIndexOf("\u25cf");
  if (bulletIndex >= 0) {
    const fromBullet = readable.slice(bulletIndex + 1);
    const firstLine = fromBullet.split(/\r?\n/)[0] ?? "";
    const cleaned = cleanAssistantLine(firstLine);
    if (cleaned) {
      return cleaned;
    }
  }

  return fallbackReadableOutput(readable);
}

function cleanAssistantLine(line: string): string {
  const [beforeTuiMarker] = line.split(inlineTuiMarkerPattern);
  return (beforeTuiMarker ?? "")
    .replace(/^[\d\s:;|>.\-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackReadableOutput(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => cleanAssistantLine(line.trim()))
    .filter((line) => line && !tuiNoiseMarkers.some((marker) => line.toLowerCase().includes(marker.toLowerCase())))
    .join("\n")
    .trim();
}
