/**
 * Maps an OS Share Sheet text intent (`expo-share-intent`, Android only for
 * now — see `app.json`'s `disableIOS`) to what the app should do about it:
 * open the grade calculator with the shared text ready to import.
 *
 * Deliberately mirrors `push/navIntent.ts`'s shape (`NavIntent`) so the
 * result can be handed straight to `WebViewContainer`'s existing
 * `handleNavIntent` — a grade share is just another non-main-tab "push"
 * destination, same as a chat/notice push notification. Kept
 * dependency-free (no RN/expo-share-intent imports beyond the type) so it
 * stays unit-testable without the native module.
 */
import { portalUrlFor } from '../webview/constants';
import type { NavIntent } from '../push/navIntent';

/**
 * Non-main-tab sub-page in the portal (`inu-portal-web`'s
 * `ROUTES.TIMETABLE.CALCULATOR`). Hardcoded rather than shared — the two
 * repos have no shared route constants (see AGENTS.md: the only shared
 * contract is the bridge submodule).
 */
const GRADE_CALCULATOR_PATH = '/timetable/calculator';

/** Query param the calculator page reads to auto-open "성적 붙여넣기" prefilled. */
const SHARED_GRADES_PARAM = 'sharedGrades';

/**
 * Hard cap on how much shared text is forwarded as a query string. Real
 * SmartCampus grade tables (a handful of semesters, tens of rows) are well
 * under 1KB; this only guards against a user sharing something unrelated
 * and unbounded (e.g. a whole document) that would otherwise be pushed
 * verbatim into a WebView navigation URL.
 */
const MAX_SHARED_TEXT_LENGTH = 20_000;

/** Minimal shape of `expo-share-intent`'s `ShareIntent` this module needs. */
export type GradeShareIntentInput = { text?: string | null };

/**
 * Build the nav intent for a shared-text intent, or `null` if there is
 * nothing usable to act on (no text, or blank).
 */
export function resolveGradeShareIntent(shareIntent: GradeShareIntentInput): NavIntent | null {
  const text = shareIntent.text?.trim();
  if (!text) return null;

  const truncated = text.slice(0, MAX_SHARED_TEXT_LENGTH);
  const path = `${GRADE_CALCULATOR_PATH}?${SHARED_GRADES_PARAM}=${encodeURIComponent(truncated)}`;
  return { kind: 'push', path, url: portalUrlFor(path) };
}
