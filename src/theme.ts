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

/** Loading-indicator tint shown over the background color above. */
export const INDICATOR_COLOR = '#8E8E93';

/**
 * Launch splash. The system splash (expo-splash-screen, app.json) and the
 * in-app splash art share these values so the hand-off between the two is
 * seamless — change them together or the logo visibly jumps.
 */
export const SPLASH_BACKGROUND = '#043799';

/**
 * Logo width (dp), fixed rather than proportional: `imageWidth` in app.json is
 * a fixed dp value on every screen size, so the in-app copy must be too.
 *
 * 178 is the largest value that still clears Android 12+'s circular splash
 * mask. The system splash fits the image into an `imageWidth`-sided square on
 * a 288dp canvas and masks it to a 192dp-diameter circle, so the logo's corner
 * must stay within radius 96dp: hypot(178/2, 71/2) = 95.9dp. The design calls
 * for 182dp, which needs 98.0dp and gets clipped.
 */
export const SPLASH_LOGO_WIDTH = 178;

/** Intrinsic aspect ratio of `assets/splash/logo-splash.png` (928 x 372). */
export const SPLASH_LOGO_RATIO = 928 / 372;
