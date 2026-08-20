/**
 * Who gets to act on a back request, and what the shell does with the answer.
 *
 * The shell never decides a back press on its own: it delegates to the page
 * (`checkBack`) and resolves the answer here. The page is the only side that
 * knows about its own `pushState`-backed modals (chat image viewer, course
 * filter overlay, search overlay), which the shell used to skip entirely —
 * popping the whole sub-page when the web only wanted its modal closed
 * (issue #15).
 *
 * Kept free of React/react-native so the policy itself is unit-testable.
 */

/** What the shell should do once the page has (or hasn't) answered. */
export type BackAction =
  /** The page consumed it (closed a modal, walked its own history). */
  | 'none'
  /** Step back inside this WebView's own history (fires `popstate`). */
  | 'webViewGoBack'
  /** Pop this sub-page off the native stack. */
  | 'popScreen'
  /** Root, bottom of the stack: "press again to exit". */
  | 'exitPrompt';

export type BackContext = {
  /**
   * The page's answer to `checkBack`: `true` handled, `false` nothing left to
   * undo, `null` no answer at all (mid-load, blocked JS thread, or a web build
   * that predates `checkBack`).
   */
  handled: boolean | null;
  /** Root portal (main-tab SPA) vs a pushed sub-page. */
  isRoot: boolean;
  /** The WebView's own `canGoBack` from `onNavigationStateChange`. */
  webViewCanGoBack: boolean;
};

export function resolveBackAction({
  handled,
  isRoot,
  webViewCanGoBack,
}: BackContext): BackAction {
  if (handled === true) return 'none';

  // No answer: fall back to the WebView's own history so a `pushState` modal
  // still gets its `popstate` even with the bridge out of reach.
  //
  // Root also takes this path on an explicit "not handled", because the page's
  // SPA depth counter is per-document: a full page load inside the root
  // WebView leaves real back entries the page can no longer see, and stepping
  // back into them always beats prompting to exit the app. A sub-page is a
  // single loaded URL, so there the page's answer is authoritative.
  if ((handled === null || isRoot) && webViewCanGoBack) return 'webViewGoBack';

  return isRoot ? 'exitPrompt' : 'popScreen';
}
