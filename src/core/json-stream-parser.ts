/**
 * Parses concatenated JSON objects from a stream of text.
 *
 * Handles:
 * - Concatenated JSON objects without newline separators (`}{`)
 * - Braces inside JSON strings (`{"text": "function() { }"}`)
 * - Escaped quotes inside JSON strings (`\"`)
 * - Unicode escape sequences (`\uXXXX`)
 * - Partial/malformed trailing JSON (silently discarded)
 * - Non-JSON text between objects (automatically skipped)
 */
export function parseJsonObjects(text: string): unknown[] {
  const objects: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char !== "}") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      const candidate = text.slice(start, index + 1);
      try {
        objects.push(JSON.parse(candidate));
      } catch {
        // Ignore malformed chunks and keep scanning after this candidate.
      }
      start = -1;
    }
  }

  return objects;
}
