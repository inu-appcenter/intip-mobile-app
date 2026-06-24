import { describe, it, expect } from '@jest/globals';

import {
  formatSession,
  formatStack,
  formatWhereAmI,
  shortUrl,
  truncate,
  type StackEntryLike,
} from '../controllerFormat';

const root: StackEntryLike = {
  mode: 'root',
  url: 'https://intip.inuappcenter.kr/home',
  path: '/home',
  canGoBack: false,
};
const sub: StackEntryLike = {
  mode: 'sub',
  url: 'https://intip.inuappcenter.kr/board/12?tab=1',
  path: '/board/12',
  canGoBack: true,
};

describe('shortUrl', () => {
  it('reduces a portal URL to its path + query', () => {
    expect(shortUrl('https://intip.inuappcenter.kr/board/12?tab=1')).toBe('/board/12?tab=1');
  });

  it('falls back to the host for a bare origin', () => {
    expect(shortUrl('https://intip.inuappcenter.kr/')).toBe('intip.inuappcenter.kr');
  });

  it('returns the input unchanged when it is not a URL', () => {
    expect(shortUrl('not a url')).toBe('not a url');
  });
});

describe('truncate', () => {
  it('leaves short values untouched', () => {
    expect(truncate('short')).toBe('short');
  });

  it('elides the middle of a long token', () => {
    const token = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const result = truncate(token);
    expect(result).toContain('…');
    expect(result.startsWith('abcdefghijkl')).toBe(true);
    expect(result.endsWith('456789')).toBe(true);
  });
});

describe('formatWhereAmI', () => {
  it('reports no WebView when nothing is active', () => {
    expect(formatWhereAmI(null, 0)).toBe('No WebView is mounted.');
  });

  it('summarizes the active container', () => {
    const text = formatWhereAmI(sub, 2);
    expect(text).toContain('mode: sub');
    expect(text).toContain('path: /board/12');
    expect(text).toContain('SPA back: yes');
    expect(text).toContain('stack depth: 2');
  });
});

describe('formatSession', () => {
  it('renders a logged-out session compactly', () => {
    const text = formatSession({ loggedIn: false, loginAt: null, fcmToken: null });
    expect(text).toContain('logged in: no');
    expect(text).toContain('fcm token: —');
  });

  it('truncates the FCM token', () => {
    const text = formatSession({
      loggedIn: true,
      loginAt: 0,
      fcmToken: 'abcdefghijklmnopqrstuvwxyz0123456789',
    });
    expect(text).toContain('…');
  });
});

describe('formatStack', () => {
  it('marks the last (active) entry', () => {
    const text = formatStack([root, sub]);
    const lines = text.split('\n');
    expect(lines[0].startsWith('  0.')).toBe(true);
    expect(lines[1].startsWith('▶ 1.')).toBe(true);
  });

  it('renders an empty stack', () => {
    expect(formatStack([])).toBe('(empty)');
  });
});
