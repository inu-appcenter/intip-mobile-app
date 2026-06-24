/**
 * Background colors shown behind the WebView while the portal loads.
 * Swift ref: light `#f7f7f7`, dark `#1C1C1E`.
 */
export const BACKGROUND_COLORS = {
  light: '#f7f7f7',
  dark: '#1C1C1E',
} as const;

export function backgroundColorFor(scheme: string | null | undefined): string {
  return scheme === 'dark' ? BACKGROUND_COLORS.dark : BACKGROUND_COLORS.light;
}
