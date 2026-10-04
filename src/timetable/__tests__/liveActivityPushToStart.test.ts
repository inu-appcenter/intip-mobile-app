import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockStore = new Map<string, string>();
const mockFetch = jest.fn<(url: string, init?: any) => Promise<{ ok: boolean }>>();
const mockGetValidAccessToken = jest.fn<() => Promise<string | null>>();
let mockSettings = { enabled: true, leadTimeMinutes: 15 };
let tokenListener: ((event: { activityPushToStartToken: string }) => void) | null = null;
let activityListener: ((event: any) => void) | null = null;

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, val: string) => {
    mockStore.set(key, val);
  }),
}));

jest.mock('expo-widgets', () => ({
  addPushToStartTokenListener: jest.fn((listener: any) => {
    tokenListener = listener;
    return { remove: jest.fn() };
  }),
}));

const mockFinishBackgroundWork = jest.fn();
jest.mock('../../../modules/intip-live-activity-tokens', () => ({
  addActivityPushTokenListener: jest.fn((listener: any) => {
    activityListener = listener;
    return { remove: jest.fn() };
  }),
  finishBackgroundWork: () => mockFinishBackgroundWork(),
}));

jest.mock('../../config/env', () => ({ API_BASE_URL: 'https://api.test' }));
jest.mock('../../native/authTokens', () => ({
  getValidAccessToken: () => mockGetValidAccessToken(),
}));
jest.mock('../timetableStorage', () => ({
  TimetableStorage: { getSettings: async () => mockSettings },
}));

type Module = typeof import('../liveActivityPushToStart');

function loadModule(): Module {
  let mod: Module | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module state per test
    mod = require('../liveActivityPushToStart');
  });
  return mod!;
}

async function flush(): Promise<void> {
  // 동기화 체인(설정 조회 → FCM 토큰 → 세션 → fetch)이 모두 끝나도록 매크로태스크까지 비운다.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function bodyOf(call: number): any {
  return JSON.parse(mockFetch.mock.calls[call][1].body);
}

describe('liveActivityPushToStart', () => {
  beforeEach(() => {
    mockStore.clear();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true });
    mockGetValidAccessToken.mockReset();
    mockGetValidAccessToken.mockResolvedValue('access');
    mockSettings = { enabled: true, leadTimeMinutes: 15 };
    tokenListener = null;
    activityListener = null;
    mockFinishBackgroundWork.mockReset();
    (global as any).fetch = mockFetch;
  });

  it('registers the push-to-start token paired with the FCM token', async () => {
    const mod = loadModule();
    mod.registerLiveActivityPushToStart();
    tokenListener!({ activityPushToStartToken: 'la-1' });
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test/api/tokens/live-activity');
    expect(mockFetch.mock.calls[0][1].method).toBe('PUT');
    expect(mockFetch.mock.calls[0][1].headers.Auth).toBe('access');
    expect(bodyOf(0)).toEqual({ token: 'test-fcm-token', liveActivityStartToken: 'la-1' });
    expect(await mod.isLiveActivityPushToStartRegistered()).toBe(true);
  });

  it('does not resend an unchanged token', async () => {
    const mod = loadModule();
    mod.registerLiveActivityPushToStart();
    tokenListener!({ activityPushToStartToken: 'la-1' });
    await flush();
    await mod.syncLiveActivityStartToken();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('unregisters when the Live Activity setting is off', async () => {
    const mod = loadModule();
    mod.registerLiveActivityPushToStart();
    tokenListener!({ activityPushToStartToken: 'la-1' });
    await flush();

    mockSettings = { enabled: false, leadTimeMinutes: 15 };
    await mod.syncLiveActivityStartToken();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(1)).toEqual({ token: 'test-fcm-token', liveActivityStartToken: null });
    expect(await mod.isLiveActivityPushToStartRegistered()).toBe(false);
  });

  it('waits for a session before registering', async () => {
    mockGetValidAccessToken.mockResolvedValue(null);
    const mod = loadModule();
    mod.registerLiveActivityPushToStart();
    tokenListener!({ activityPushToStartToken: 'la-1' });
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();

    mockGetValidAccessToken.mockResolvedValue('access');
    await mod.syncLiveActivityStartToken();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed request', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const mod = loadModule();
    mod.registerLiveActivityPushToStart();
    tokenListener!({ activityPushToStartToken: 'la-1' });
    await flush();
    expect(await mod.isLiveActivityPushToStartRegistered()).toBe(false);

    await mod.syncLiveActivityStartToken();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(await mod.isLiveActivityPushToStartRegistered()).toBe(true);
  });

  it('registers each timetable Live Activity update token', async () => {
    const mod = loadModule();
    mod.registerLiveActivityPushToStart();
    activityListener!({ activityId: 'A1', pushToken: 'up-1', name: 'TimetableLiveActivity', props: '{"phase":"UPCOMING"}' });
    activityListener!({ activityId: 'X', pushToken: 'up-x', name: 'SomeOtherActivity', props: '{}' });
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test/api/tokens/live-activity/activities');
    expect(bodyOf(0)).toEqual({
      token: 'test-fcm-token',
      activityId: 'A1',
      pushToken: 'up-1',
      props: '{"phase":"UPCOMING"}',
    });

    // 다 보냈으면 백그라운드 실행 시간을 돌려준다
    expect(mockFinishBackgroundWork).toHaveBeenCalledTimes(1);

    // 이미 보낸 토큰은 다시 보내지 않는다
    await mod.syncLiveActivityStartToken();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps an activity token until a session exists', async () => {
    mockGetValidAccessToken.mockResolvedValue(null);
    const mod = loadModule();
    mod.registerLiveActivityPushToStart();
    activityListener!({ activityId: 'A1', pushToken: 'up-1', name: 'TimetableLiveActivity', props: '{}' });
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockFinishBackgroundWork).not.toHaveBeenCalled();

    mockGetValidAccessToken.mockResolvedValue('access');
    await mod.syncLiveActivityStartToken();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(bodyOf(0).activityId).toBe('A1');
  });

  it('restores the registered flag across launches', async () => {
    mockStore.set('intip_live_activity_push_to_start_registered', '1');
    const mod = loadModule();
    expect(await mod.isLiveActivityPushToStartRegistered()).toBe(true);
  });
});
