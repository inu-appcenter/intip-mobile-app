/**
 * Pure URL → filename derivation for downloads. Kept dependency-free (no
 * react-native / blob-util imports) so it is unit-testable on its own.
 */

/** Derive a download filename from a URL's last path segment. */
export function fileNameFromUrl(url: string, fallback = 'download'): string {
  try {
    const path = new URL(url).pathname;
    const last = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '');
    return last || fallback;
  } catch {
    return fallback;
  }
}
