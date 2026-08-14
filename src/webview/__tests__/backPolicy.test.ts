import { describe, it, expect } from '@jest/globals';
import { resolveBackAction } from '../backPolicy';

describe('resolveBackAction', () => {
  describe('the page handled it', () => {
    it('does nothing, whatever the shell thinks (sub-page modal closed)', () => {
      expect(
        resolveBackAction({ handled: true, isRoot: false, webViewCanGoBack: true }),
      ).toBe('none');
      expect(
        resolveBackAction({ handled: true, isRoot: false, webViewCanGoBack: false }),
      ).toBe('none');
    });

    it('does nothing on the root either', () => {
      expect(
        resolveBackAction({ handled: true, isRoot: true, webViewCanGoBack: true }),
      ).toBe('none');
    });
  });

  describe('the page has nothing left to undo', () => {
    it('pops the sub-page screen', () => {
      expect(
        resolveBackAction({ handled: false, isRoot: false, webViewCanGoBack: false }),
      ).toBe('popScreen');
    });

    it('still pops the sub-page even with WebView history (single loaded URL)', () => {
      expect(
        resolveBackAction({ handled: false, isRoot: false, webViewCanGoBack: true }),
      ).toBe('popScreen');
    });

    it('prompts to exit at the bottom of the root stack', () => {
      expect(
        resolveBackAction({ handled: false, isRoot: true, webViewCanGoBack: false }),
      ).toBe('exitPrompt');
    });

    it('prefers the root WebView document history over exiting the app', () => {
      expect(
        resolveBackAction({ handled: false, isRoot: true, webViewCanGoBack: true }),
      ).toBe('webViewGoBack');
    });
  });

  describe('the page never answered (timeout / old web build)', () => {
    it('walks the WebView history so a pushState modal still gets popstate', () => {
      expect(
        resolveBackAction({ handled: null, isRoot: false, webViewCanGoBack: true }),
      ).toBe('webViewGoBack');
      expect(
        resolveBackAction({ handled: null, isRoot: true, webViewCanGoBack: true }),
      ).toBe('webViewGoBack');
    });

    it('falls back to the pre-delegation behaviour with no history', () => {
      expect(
        resolveBackAction({ handled: null, isRoot: false, webViewCanGoBack: false }),
      ).toBe('popScreen');
      expect(
        resolveBackAction({ handled: null, isRoot: true, webViewCanGoBack: false }),
      ).toBe('exitPrompt');
    });
  });
});
