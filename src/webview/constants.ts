/**
 * Static configuration for the INTIP portal shell.
 *
 * Mirrors the constants baked into the original native apps
 * (`WebViewActivity.kt`, `WebViewController.swift`, `getMobilePlatform.ts`).
 */

/**
 * The portal the WebView hosts. Loaded on every launch.
 * https, not http: the host 301-redirects cleartext to https, so an `http://`
 * origin cost every launch (and every `portalUrlFor` push) a wasted round-trip
 * before the first byte of HTML.
 */
export const ROOT_URL = "https://intip.inuappcenter.kr";

/** Host that is considered "internal". Anything else opens in the system browser. */
export const PORTAL_HOST = "intip.inuappcenter.kr";

/**
 * Hosts a push notification's payload is allowed to point off-portal to (e.g.
 * school/department notice originals we don't control). Anything else is
 * ignored rather than opened — a notification payload is outside our trust
 * boundary, so it must not be able to make the app open an arbitrary URL.
 */
export const PUSH_EXTERNAL_HOSTS = ["inu.ac.kr"] as const;

/**
 * Hosts whose https links this app claims as deep links (iOS Universal Links /
 * Android App Links). Both hosts serve the same portal — test and production —
 * and a link can be shared from either, so both are claimed.
 *
 * Must stay in sync with `app.json` (`ios.associatedDomains`,
 * `android.intentFilters`) and with the domain-association files the web repo
 * serves (`inu-portal-web`, `public/app-links/`). The native side decides
 * *whether* the app opens at all; this list is what the JS side then trusts.
 */
export const DEEP_LINK_HOSTS = [
  "intip.inuappcenter.kr",
  "intip-test.pages.dev",
] as const;

/**
 * Portal paths a deep link must never route into the app shell.
 *
 * These are static pages the store listings and external sites link to
 * (privacy policy / terms) plus the domain-association files themselves.
 * iOS honours the matching `exclude` rules in the web's
 * `apple-app-site-association` and never hands them to us — but Android app
 * links match at host granularity (intent filters can only *include* paths),
 * so on Android the app does get opened for them and has to hand them back to
 * a browser itself. Keep this list and the AASA `exclude` components equal.
 */
export const DEEP_LINK_EXCLUDED_PATHS = [
  "/privacy-policy.html",
  "/terms-of-use.html",
] as const;

/** Prefix form of the same exclusion (everything under `/.well-known/`). */
export const DEEP_LINK_EXCLUDED_PREFIXES = ["/.well-known/"] as const;

/**
 * Suffix appended to the WebView User-Agent so the web frontend detects the
 * official app and switches to the multi-WebView routing protocol (spec §2.A).
 * The WebView's `applicationNameForUserAgent` joins it with a single space,
 * reproducing the original `" INTIPApp/1.0.0"` suffix.
 */
export const APP_UA_SUFFIX = "INTIPApp/1.0.0";

/**
 * Main-tab paths (spec §3.A). These stay inside the single root WebView via SPA
 * routing and never push a native sub-WebView. The `/m` mobile prefix maps to
 * the same set (e.g. `/m/home` === `/home`). While the root sits on one of
 * these, the interactive back gesture (iOS) and hardware back are disabled.
 */
export const MAIN_TAB_PATHS = [
  "/",
  "/home",
  "/bus",
  "/chat/list",
  "/save",
  "/mypage",
  "/timetable",
] as const;

const MOBILE_PREFIX = "/m";

/** Strip a leading `/m` mobile prefix so `/m/home` is treated as `/home`. */
export function normalizePath(pathname: string): string {
  const path = pathname.split("?")[0].split("#")[0];
  if (path === MOBILE_PREFIX) return "/";
  if (path.startsWith(MOBILE_PREFIX + "/"))
    return path.slice(MOBILE_PREFIX.length);
  return path;
}

/** True when the pathname is a main tab (back gesture disabled, SPA routed). */
export function isMainTabPath(pathname: string): boolean {
  return (MAIN_TAB_PATHS as readonly string[]).includes(
    normalizePath(pathname),
  );
}

/**
 * Absolute portal URL for an in-portal `path` (which may carry a query
 * string, e.g. `/councilnoticedetail?id=456`). Used to build the `url` a
 * `push` nav intent needs — the pushed sub-page screen (`app/webview.tsx`)
 * only accepts portal origins (`isPortalUrl` guard), so a native-triggered
 * sub-page push must be given a fully-qualified URL, not just a path. Mirrors
 * what the web computes for `navigateTo` (`${location.origin}${path}`).
 */
export function portalUrlFor(path: string): string {
  return new URL(path, ROOT_URL).toString();
}

/** Korean dialog copy, carried over verbatim from the native app. */
export const STRINGS = {
  /** Button copy for dialogs with nothing app-specific to say (e.g. web `alert()`). */
  common: {
    confirm: "확인",
  },
  appUpdate: {
    title: "화면 업데이트",
    message: "로그인 정보는 유지되며, 최신 화면으로 업데이트를 진행합니다.",
    confirm: "확인",
    cancel: "취소",
  },
  download: {
    title: "다운로드 완료",
    message: "파일이 저장되었습니다.",
  },
  network: {
    title: "네트워크 연결 실패",
    message: "네트워크가 연결되어 있지 않습니다. 연결 후 다시 시도해주세요.",
    retry: "재시도",
    exit: "앱 종료",
    close: "닫기",
  },
} as const;

/**
 * Width (dp / CSS px) of the band along each screen edge that the system
 * reserves for its back gesture. AOSP's inset is 20dp; OEM skins (One UI) can
 * widen it, so guard slightly more than the platform minimum.
 *
 * Shared by the native edge guard (`WebViewContainer`) and the in-page
 * long-press suppressor (`buildEdgeLongPressGuardScript`) so both agree on
 * exactly which touches belong to the back gesture.
 */
export const SYSTEM_BACK_GESTURE_EDGE_DP = 24;
