import { describe, it, expect } from '@jest/globals';

import {
  EMPTY_SESSION,
  parseSnapshot,
  serializeSnapshot,
  type SessionState,
} from '../sessionSnapshot';

const session: SessionState = { loggedIn: true, loginAt: 1000, fcmToken: 'tok' };
const stack = [
  { mode: 'root' as const, url: 'https://intip.inuappcenter.kr/home', path: '/home', extra: 1 },
  { mode: 'sub' as const, url: 'https://intip.inuappcenter.kr/board/12', path: '/board/12' },
];

describe('serializeSnapshot', () => {
  it('captures only the persisted entry fields and a fixed version', () => {
    const snap = serializeSnapshot(stack, session, 42);
    expect(snap).toEqual({
      version: 1,
      savedAt: 42,
      session: { loggedIn: true, loginAt: 1000, fcmToken: 'tok' },
      stack: [
        { mode: 'root', url: 'https://intip.inuappcenter.kr/home', path: '/home' },
        { mode: 'sub', url: 'https://intip.inuappcenter.kr/board/12', path: '/board/12' },
      ],
    });
  });

  it('copies the session rather than aliasing it', () => {
    const snap = serializeSnapshot([], session, 0);
    expect(snap.session).not.toBe(session);
    expect(snap.session).toEqual(session);
  });
});

describe('parseSnapshot', () => {
  it('round-trips a serialized snapshot', () => {
    const snap = serializeSnapshot(stack, session, 7);
    expect(parseSnapshot(JSON.stringify(snap))).toEqual(snap);
  });

  it('returns null for non-JSON / non-object input', () => {
    expect(parseSnapshot('not json')).toBeNull();
    expect(parseSnapshot('42')).toBeNull();
    expect(parseSnapshot('null')).toBeNull();
  });

  it('returns null for an unknown version', () => {
    expect(parseSnapshot(JSON.stringify({ version: 2, stack: [] }))).toBeNull();
  });

  it('returns null when the stack is missing', () => {
    expect(parseSnapshot(JSON.stringify({ version: 1, savedAt: 1 }))).toBeNull();
  });

  it('drops malformed entries but keeps valid ones', () => {
    const raw = JSON.stringify({
      version: 1,
      savedAt: 5,
      session: {},
      stack: [
        { mode: 'sub', url: 'https://x/y', path: '/y' },
        { mode: 'bogus', url: 'https://x/z', path: '/z' }, // bad mode
        { mode: 'sub', url: '', path: '/empty' }, // empty url
        { mode: 'root' }, // missing url
      ],
    });
    const parsed = parseSnapshot(raw);
    expect(parsed?.stack).toEqual([{ mode: 'sub', url: 'https://x/y', path: '/y' }]);
  });

  it('defaults a missing/partial session to the empty session', () => {
    const parsed = parseSnapshot(JSON.stringify({ version: 1, savedAt: 0, stack: [] }));
    expect(parsed?.session).toEqual(EMPTY_SESSION);
  });

  it('coerces a non-string path to an empty string', () => {
    const raw = JSON.stringify({
      version: 1,
      savedAt: 0,
      stack: [{ mode: 'sub', url: 'https://x/y', path: 99 }],
    });
    expect(parseSnapshot(raw)?.stack[0].path).toBe('');
  });
});
