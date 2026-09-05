import { describe, it, expect } from '@jest/globals';
import { PORTAL_HOST, portalUrlFor } from '../../webview/constants';
import { extractFcmMessageId, resolveNavIntent } from '../navIntent';

describe('resolveNavIntent', () => {
  describe('fcmMessageId', () => {
    it('parses the server payload string and retains it on the navigation intent', () => {
      expect(extractFcmMessageId({ fcmMessageId: '1234' })).toBe(1234);
      expect(resolveNavIntent({ path: '/posts/55', fcmMessageId: '1234' })).toEqual({
        kind: 'push',
        path: '/posts/55',
        url: portalUrlFor('/posts/55'),
        fcmMessageId: 1234,
      });
    });

    it('retains notification analytics metadata on the navigation intent', () => {
      expect(
        resolveNavIntent({
          path: '/posts/55',
          fcmMessageId: '1234',
          notificationType: 'promotion',
          campaignId: 'campaign_202609',
          sentAt: '2026-09-05T05:00:00.000Z',
        }),
      ).toEqual({
        kind: 'push',
        path: '/posts/55',
        url: portalUrlFor('/posts/55'),
        fcmMessageId: 1234,
        notificationType: 'promotion',
        campaignId: 'campaign_202609',
        sentAt: '2026-09-05T05:00:00.000Z',
      });
    });

    it('rejects malformed, non-positive, and unsafe notification ids', () => {
      expect(extractFcmMessageId({ fcmMessageId: '12.5' })).toBeUndefined();
      expect(extractFcmMessageId({ fcmMessageId: '0' })).toBeUndefined();
      expect(extractFcmMessageId({ fcmMessageId: '-1' })).toBeUndefined();
      expect(extractFcmMessageId({ fcmMessageId: '9007199254740992' })).toBeUndefined();
    });
  });

  describe('empty / missing input', () => {
    it('returns null when there is no data', () => {
      expect(resolveNavIntent(undefined)).toBeNull();
      expect(resolveNavIntent({})).toBeNull();
    });

    it('returns null when type is present but no path/route/link/url field', () => {
      expect(resolveNavIntent({ type: 'GENERAL' })).toBeNull();
    });

    it('rejects non-string and empty candidates', () => {
      expect(resolveNavIntent({ path: 123 as unknown as string })).toBeNull();
      expect(resolveNavIntent({ path: '' })).toBeNull();
    });

    it('rejects malformed strings that are neither an absolute path nor a URL', () => {
      expect(resolveNavIntent({ url: 'not a url' })).toBeNull();
    });
  });

  // Server payload spec (docs/push-notification-routing/plan.md): FCM `data`
  // values are always strings; `SCHOOL_NOTICE`/`DEPARTMENT` carry an external
  // URL, `GENERAL`/`CHAT`/`FRIEND` carry a portal-relative path (+ query).
  describe('server example payloads (data.type)', () => {
    it('SCHOOL_NOTICE: external URL on the allow-listed school domain -> external', () => {
      const data = {
        type: 'SCHOOL_NOTICE',
        path: 'https://notice.inu.ac.kr/notice/123',
        targetId: '123',
        noticeId: '123',
      };
      expect(resolveNavIntent(data)).toEqual({
        kind: 'external',
        url: 'https://notice.inu.ac.kr/notice/123',
      });
    });

    it('DEPARTMENT: external URL on a department subdomain -> external', () => {
      const data = {
        type: 'DEPARTMENT',
        path: 'https://cse.inu.ac.kr/notice/456',
        targetId: '456',
        noticeId: '456',
      };
      expect(resolveNavIntent(data)).toEqual({
        kind: 'external',
        url: 'https://cse.inu.ac.kr/notice/456',
      });
    });

    it('GENERAL: portal path + query, non-main-tab -> push with query preserved', () => {
      const data = { type: 'GENERAL', path: '/councilnoticedetail?id=456', targetId: '456' };
      expect(resolveNavIntent(data)).toEqual({
        kind: 'push',
        path: '/councilnoticedetail?id=456',
        url: portalUrlFor('/councilnoticedetail?id=456'),
      });
    });

    it('CHAT: portal path to a specific room, non-main-tab -> push', () => {
      const data = { type: 'CHAT', path: '/chat/789', chatRoomId: '789', targetId: '789' };
      expect(resolveNavIntent(data)).toEqual({
        kind: 'push',
        path: '/chat/789',
        url: portalUrlFor('/chat/789'),
      });
    });

    it('FRIEND: portal path, non-main-tab -> push', () => {
      const data = { type: 'FRIEND', path: '/friend/list', targetId: 'me' };
      expect(resolveNavIntent(data)).toEqual({
        kind: 'push',
        path: '/friend/list',
        url: portalUrlFor('/friend/list'),
      });
    });
  });

  describe('main-tab vs non-main-tab branching', () => {
    it('routes main-tab paths as "spa"', () => {
      expect(resolveNavIntent({ path: '/home' })).toEqual({ kind: 'spa', path: '/home' });
      expect(resolveNavIntent({ path: '/chat/list' })).toEqual({ kind: 'spa', path: '/chat/list' });
    });

    it('routes the /m mobile-prefixed alias of a main-tab path as "spa"', () => {
      expect(resolveNavIntent({ path: '/m/home' })).toEqual({ kind: 'spa', path: '/m/home' });
    });

    it('routes non-main-tab paths as "push" with a fully-qualified portal url', () => {
      expect(resolveNavIntent({ path: '/chat/789' })).toEqual({
        kind: 'push',
        path: '/chat/789',
        url: portalUrlFor('/chat/789'),
      });
    });

    it('preserves the query string on a "push" path (the G3 pitfall)', () => {
      const result = resolveNavIntent({ path: '/councilnoticedetail?id=456' });
      expect(result).toEqual({
        kind: 'push',
        path: '/councilnoticedetail?id=456',
        url: portalUrlFor('/councilnoticedetail?id=456'),
      });
      // The id must not be truncated by normalizePath's `?`-stripping, which
      // is only meant to feed the main-tab check.
      expect((result as { path: string }).path).toContain('id=456');
    });
  });

  describe('portal absolute URL -> relative path conversion', () => {
    it('converts a main-tab absolute portal URL to "spa"', () => {
      expect(resolveNavIntent({ url: `https://${PORTAL_HOST}/home` })).toEqual({
        kind: 'spa',
        path: '/home',
      });
    });

    it('converts a non-main-tab absolute portal URL to "push", search preserved', () => {
      expect(resolveNavIntent({ url: `https://${PORTAL_HOST}/councilnoticedetail?id=456` })).toEqual({
        kind: 'push',
        path: '/councilnoticedetail?id=456',
        url: portalUrlFor('/councilnoticedetail?id=456'),
      });
    });
  });

  describe('off-portal allowlist (G1)', () => {
    it('resolves an allow-listed external host as "external"', () => {
      expect(resolveNavIntent({ path: 'https://inu.ac.kr/notice/123' })).toEqual({
        kind: 'external',
        url: 'https://inu.ac.kr/notice/123',
      });
    });

    it('resolves a subdomain of an allow-listed host as "external"', () => {
      expect(resolveNavIntent({ path: 'https://cse.inu.ac.kr/notice/123' })).toEqual({
        kind: 'external',
        url: 'https://cse.inu.ac.kr/notice/123',
      });
    });

    it('rejects a non-allow-listed external host', () => {
      expect(resolveNavIntent({ url: 'https://evil.example.com/board/12' })).toBeNull();
    });

    it('rejects a host that merely ends with the allow-listed domain as a substring', () => {
      // "notinu.ac.kr" is not a subdomain of "inu.ac.kr" — no dot boundary.
      expect(resolveNavIntent({ url: 'https://notinu.ac.kr/board/12' })).toBeNull();
      // Nor is a domain that happens to start with it, e.g. a lookalike suffix.
      expect(resolveNavIntent({ url: 'https://inu.ac.kr.evil.com/board/12' })).toBeNull();
    });

    it('rejects a non-http(s) scheme even on an allow-listed-looking host string', () => {
      expect(resolveNavIntent({ path: 'ftp://inu.ac.kr/notice/123' })).toBeNull();
    });
  });

  describe('data field precedence + all-string payloads', () => {
    it('honours the path/route/link/url precedence, all values as strings', () => {
      expect(resolveNavIntent({ route: '/chat/1' })).toEqual({
        kind: 'push',
        path: '/chat/1',
        url: portalUrlFor('/chat/1'),
      });
      expect(resolveNavIntent({ link: '/chat/2' })).toEqual({
        kind: 'push',
        path: '/chat/2',
        url: portalUrlFor('/chat/2'),
      });
      expect(resolveNavIntent({ path: '/chat/3', route: '/chat/4' })).toEqual({
        kind: 'push',
        path: '/chat/3',
        url: portalUrlFor('/chat/3'),
      });
    });

    it('works when every data value is a string, including targetId-style fields', () => {
      const data = {
        type: 'CHAT',
        path: '/chat/789',
        targetId: '789',
        chatRoomId: '789',
      } satisfies Record<string, string>;
      expect(resolveNavIntent(data)).toEqual({
        kind: 'push',
        path: '/chat/789',
        url: portalUrlFor('/chat/789'),
      });
    });
  });
});
