/**
 * Guards against unsafe protocols in user-facing external URLs.
 *
 * Used for links that open in a new browser tab (target="_blank"), where
 * protocols like javascript: and data: would execute arbitrary code.
 * Only absolute http(s) URLs are considered safe for external navigation.
 */
export function isSafeExternalUrl(raw: string): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
