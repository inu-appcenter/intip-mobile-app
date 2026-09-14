import { describe, it, expect } from '@jest/globals';

import {
  parseTokenProbe,
  resolveWebToken,
  TOKEN_PROBE_MARKER,
  TOKEN_PROBE_SCRIPT,
} from '../tokenProbe';

const pair = (accessToken: string, accessTokenExpiredTime: string) => ({
  accessToken,
  accessTokenExpiredTime,
  refreshToken: `refresh-${accessToken}`,
  refreshTokenExpiredTime: '2026-10-01T00:00:00',
});

const reply = (stored: string | null) => JSON.stringify({ [TOKEN_PROBE_MARKER]: stored });

describe('TOKEN_PROBE_SCRIPT', () => {
  it('is valid JavaScript with no backslash escapes to be eaten', () => {
    expect(TOKEN_PROBE_SCRIPT).not.toContain('\\');
    expect(() => new Function(TOKEN_PROBE_SCRIPT)).not.toThrow();
  });

  it('posts the stored token under the marker', () => {
    const posted: string[] = [];
    const window = {
      localStorage: { getItem: (key: string) => (key === 'tokenInfo' ? '{"a":1}' : null) },
      ReactNativeWebView: { postMessage: (m: string) => posted.push(m) },
    };
    new Function('window', TOKEN_PROBE_SCRIPT)(window);
    expect(posted).toEqual([reply('{"a":1}')]);
  });
});

describe('parseTokenProbe', () => {
  it('ignores messages that are not probe replies', () => {
    expect(parseTokenProbe('{"event":"routeChange","value":"/","v":1}')).toBeUndefined();
    expect(parseTokenProbe('not json')).toBeUndefined();
  });

  it('returns the web token when one is stored', () => {
    const token = pair('a1', '2026-09-14T12:00:00');
    expect(parseTokenProbe(reply(JSON.stringify(token)))).toEqual({ token });
  });

  it('reports no token for a logged-out or unrecognised store', () => {
    expect(parseTokenProbe(reply(null))).toEqual({ token: null });
    // What the web writes on logout: the empty pair.
    expect(parseTokenProbe(reply(JSON.stringify(pair('', ''))))).toEqual({ token: null });
    expect(parseTokenProbe(reply('garbage'))).toEqual({ token: null });
  });
});

describe('resolveWebToken', () => {
  const older = pair('old', '2026-09-14T10:00:00');
  const newer = pair('new', '2026-09-14T11:30:00.123456789');

  it('adopts when native holds nothing — the reinstall case', () => {
    expect(resolveWebToken(newer, null)).toBe('adopt');
  });

  it('adopts a newer web pair', () => {
    expect(resolveWebToken(newer, older)).toBe('adopt');
  });

  it('keeps a newer native pair instead of reviving the web\'s retired one', () => {
    expect(resolveWebToken(older, newer)).toBe('keep');
  });

  it('keeps an identical pair', () => {
    expect(resolveWebToken(newer, newer)).toBe('keep');
  });

  it('clears native when the web is logged out', () => {
    expect(resolveWebToken(null, newer)).toBe('clear');
    expect(resolveWebToken(null, null)).toBe('keep');
  });
});
