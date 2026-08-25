import { Platform } from 'react-native';

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
 * Logo width (dp) as authored for the system splash: fixed rather than
 * proportional, because `imageWidth` in app.json is a fixed dp value on every
 * screen size.
 *
 * 178 is the largest value that still clears Android 12+'s circular splash
 * mask. The system splash fits the image into an `imageWidth`-sided square on
 * a 288dp canvas and masks it to a 192dp-diameter circle, so the logo's corner
 * must stay within radius 96dp: hypot(178/2, 71/2) = 95.9dp. The design calls
 * for 182dp, which needs 98.0dp and gets clipped.
 */
const SPLASH_LOGO_AUTHORED_WIDTH = 178;

/**
 * What the in-app splash art actually draws — it has to match whatever width
 * the system splash actually put on screen, or the logo visibly resizes at the
 * hand-off.
 *
 * The generated drawable is always a 288dp canvas (expo-splash-screen
 * hardcodes `canvasSize = 288 * multiplier`) with the logo centred at
 * `imageWidth` inside it, and the platform decides how large that canvas is
 * drawn. Measured on real hardware, same APK, logo width on screen:
 *
 *   emulator        Android 10  (AOSP)      177dp
 *   Galaxy Note10+  Android 12  One UI 4.1   88.6dp   <- half
 *   Galaxy S23 FE   Android 13  One UI 5.1  ~178dp
 *   SM-S947N        Android 16  One UI 8.5   176dp
 *
 * So Android 12 draws the canvas at half scale and everything either side of
 * it renders about 1:1. It is an undocumented OEM bug — the platform spec
 * states the 288dp/192dp-circle geometry as absolute, with no device
 * variation, and the same "logo is half size on Samsung" report is open
 * upstream in react-native-bootsplash (#466, Galaxy S20+, correct on Pixel).
 *
 * Hence the API window rather than a blanket Android branch. Below API 31 the
 * platform splash is not involved at all: androidx's compat path draws the
 * same drawable itself, into a box of `splashscreen_icon_size_no_background`
 * = 288dp — the canvas's own size, hence the 1:1 measured on Android 10.
 *
 * The upper edge is the one guess left: API 32 (Android 12L / One UI 4.1.1)
 * is grouped with the buggy release because it ships the same One UI 4
 * generation, but it was never measured. Re-measure before moving it.
 *
 * iOS renders the launch screen image at its authored size, so it keeps 178dp.
 */
const HALVED_SPLASH_ICON_API_RANGE = { first: 31, last: 32 };

export const SPLASH_LOGO_WIDTH =
  Platform.OS === 'android' &&
  (Platform.Version as number) >= HALVED_SPLASH_ICON_API_RANGE.first &&
  (Platform.Version as number) <= HALVED_SPLASH_ICON_API_RANGE.last
    ? SPLASH_LOGO_AUTHORED_WIDTH / 2
    : SPLASH_LOGO_AUTHORED_WIDTH;

/** Intrinsic aspect ratio of `assets/splash/logo-splash.png` (928 x 372). */
export const SPLASH_LOGO_RATIO = 928 / 372;
