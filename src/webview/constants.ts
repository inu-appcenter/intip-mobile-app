/**
 * Static configuration for the INTIP portal shell.
 *
 * Mirrors the constants baked into the original native apps
 * (`WebViewActivity.kt`, `WebViewController.swift`, `getMobilePlatform.ts`).
 */

/** The portal the WebView hosts. Loaded on every launch. */
export const ROOT_URL = "http://localhost:5173";

/** Host that is considered "internal". Anything else opens in the system browser. */
export const PORTAL_HOST = "localhost:5173";

/**
 * Hosts a push notification's payload is allowed to point off-portal to (e.g.
 * school/department notice originals we don't control). Anything else is
 * ignored rather than opened — a notification payload is outside our trust
 * boundary, so it must not be able to make the app open an arbitrary URL.
 */
export const PUSH_EXTERNAL_HOSTS = ["inu.ac.kr"] as const;

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

/** Korean dialog copy, carried over verbatim from the native app. */
export const STRINGS = {
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
