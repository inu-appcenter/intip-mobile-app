import { describe, it, expect } from '@jest/globals';

import { portalUrlFor } from '../constants';
import { openSubPageDepth, SUB_PAGE_ROUTE } from '../subPageStack';

/** Root stack state with `index` plus the given sub-page urls, bottom-first. */
const stackOf = (...urls: string[]) => ({
  index: urls.length,
  routes: [
    { name: 'index' },
    ...urls.map((url) => ({ name: SUB_PAGE_ROUTE, params: { url, path: new URL(url).pathname } })),
  ],
});

const CHAT = portalUrlFor('/chat/5');
const OTHER = portalUrlFor('/chat/9');

describe('openSubPageDepth', () => {
  describe('nothing to match', () => {
    it('returns null for an empty / missing state', () => {
      expect(openSubPageDepth(undefined, CHAT)).toBeNull();
      expect(openSubPageDepth({}, CHAT)).toBeNull();
      expect(openSubPageDepth({ routes: [] }, CHAT)).toBeNull();
    });

    it('returns null when only the root screen is mounted', () => {
      expect(openSubPageDepth(stackOf(), CHAT)).toBeNull();
    });

    it('returns null when the open sub-pages are all other destinations', () => {
      expect(openSubPageDepth(stackOf(OTHER), CHAT)).toBeNull();
    });

    it('returns null for a target that is not a URL', () => {
      expect(openSubPageDepth(stackOf(CHAT), '/chat/5')).toBeNull();
      expect(openSubPageDepth(stackOf(CHAT), '')).toBeNull();
    });

    it('ignores sub-page routes with a missing or non-string url param', () => {
      const state = {
        index: 1,
        routes: [{ name: 'index' }, { name: SUB_PAGE_ROUTE, params: { path: '/chat/5' } }],
      };
      expect(openSubPageDepth(state, CHAT)).toBeNull();
    });
  });

  describe('already open', () => {
    it('returns 0 when the target is the top-most screen', () => {
      expect(openSubPageDepth(stackOf(CHAT), CHAT)).toBe(0);
      expect(openSubPageDepth(stackOf(OTHER, CHAT), CHAT)).toBe(0);
    });

    it('returns how many screens sit on top of it', () => {
      expect(openSubPageDepth(stackOf(CHAT, OTHER), CHAT)).toBe(1);
      expect(openSubPageDepth(stackOf(CHAT, OTHER, OTHER), CHAT)).toBe(2);
    });

    it('resolves to the nearest copy when the page is open more than once', () => {
      expect(openSubPageDepth(stackOf(CHAT, OTHER, CHAT, OTHER), CHAT)).toBe(1);
    });

    it('measures depth from the focused index, not the array length', () => {
      const state = { ...stackOf(CHAT, OTHER), index: 1 };
      expect(openSubPageDepth(state, CHAT)).toBe(0);
    });

    it('falls back to the last route when the state carries no index', () => {
      const { routes } = stackOf(CHAT, OTHER);
      expect(openSubPageDepth({ routes }, CHAT)).toBe(1);
    });
  });

  describe('URL normalization', () => {
    it('treats the /m mobile prefix as the same destination', () => {
      expect(openSubPageDepth(stackOf(portalUrlFor('/m/chat/5')), CHAT)).toBe(0);
    });

    it('ignores a hash and a trailing slash', () => {
      expect(openSubPageDepth(stackOf(portalUrlFor('/chat/5/#last')), CHAT)).toBe(0);
    });

    it('keeps the query string significant', () => {
      const withQuery = portalUrlFor('/noticedetail?id=1');
      expect(openSubPageDepth(stackOf(withQuery), portalUrlFor('/noticedetail?id=2'))).toBeNull();
      expect(openSubPageDepth(stackOf(withQuery), withQuery)).toBe(0);
    });

    it('keeps the host significant', () => {
      expect(openSubPageDepth(stackOf(CHAT), 'https://example.com/chat/5')).toBeNull();
    });
  });

  it('finds the sub-page stack when it is nested inside another navigator', () => {
    const nested = { index: 0, routes: [{ name: 'shell', state: stackOf(CHAT, OTHER) }] };
    expect(openSubPageDepth(nested, CHAT)).toBe(1);
  });
});
