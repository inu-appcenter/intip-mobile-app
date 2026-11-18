import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import * as SecureStore from 'expo-secure-store';
import { getSession, getValidAccessToken } from '../authTokens';
import { saveTokenInfo } from '../secureTokenStore';

const mockStore = new Map<string, string>();
let mockLocked = false;
const mockFetch = jest.fn<(url: string, init?: any) => Promise<any>>();

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
  getItemAsync: jest.fn(async (key: string) => {
    if (mockLocked) throw new Error('User interaction is not allowed.');
    return mockStore.get(key) ?? null;
  }),
  setItemAsync: jest.fn(async (key: string, val: string) => {
    mockStore.set(key, val);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));
jest.mock('../../config/env', () => ({ API_BASE_URL: 'https://api.test' }));

const KEY = 'intip.tokenInfo';
const PAST = '2000-01-01T00:00:00';
const FUTURE = '2999-01-01T00:00:00';

function store(accessTokenExpiredTime: string, refreshTokenExpiredTime = FUTURE) {
  mockStore.set(
    KEY,
    JSON.stringify({
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiredTime,
      refreshTokenExpiredTime,
    }),
  );
}

beforeEach(() => {
  mockStore.clear();
  mockLocked = false;
  mockFetch.mockReset();
  (globalThis as any).fetch = mockFetch;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('getSession', () => {
  it('is none when nothing is stored', async () => {
    expect(await getSession()).toEqual({ state: 'none' });
  });

  it('is valid without a request while the access token is live', async () => {
    store(FUTURE);
    expect((await getSession()).state).toBe('valid');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('is unknown, not none, when the keychain is locked', async () => {
    store(FUTURE);
    mockLocked = true;
    expect(await getSession()).toEqual({ state: 'unknown' });
    expect(await getValidAccessToken()).toBeNull();
    expect(mockStore.has(KEY)).toBe(true);
  });

  it('is unknown and keeps the token when the refresh request fails', async () => {
    store(PAST);
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    expect(await getSession()).toEqual({ state: 'unknown' });
    expect(mockStore.has(KEY)).toBe(true);
  });

  it('is unknown and keeps the token on a server error', async () => {
    store(PAST);
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    expect(await getSession()).toEqual({ state: 'unknown' });
    expect(mockStore.has(KEY)).toBe(true);
  });

  it('is none and clears the token when the server rejects the refresh token', async () => {
    store(PAST);
    mockFetch.mockResolvedValue({ ok: false, status: 401 });
    expect(await getSession()).toEqual({ state: 'none' });
    expect(mockStore.has(KEY)).toBe(false);
  });

  it('is none when the refresh token itself has expired', async () => {
    store(PAST, PAST);
    expect(await getSession()).toEqual({ state: 'none' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('persists and returns the rotated pair after a refresh', async () => {
    store(PAST);
    const rotated = {
      accessToken: 'access2',
      refreshToken: 'refresh2',
      accessTokenExpiredTime: FUTURE,
      refreshTokenExpiredTime: FUTURE,
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: rotated }) });
    expect(await getValidAccessToken()).toBe('access2');
    expect(JSON.parse(mockStore.get(KEY)!)).toEqual(rotated);
  });
});

describe('saveTokenInfo', () => {
  it('recreates the item so it is readable on a locked device', async () => {
    store(FUTURE);
    await saveTokenInfo(JSON.parse(mockStore.get(KEY)!));
    const options = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(KEY, options);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(KEY, expect.any(String), options);
  });
});
