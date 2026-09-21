import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { handleTimetableBridgeMessage } from '../timetableBridgeHandler';

const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, val: string) => {
    mockStore.set(key, val);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    createChannel: jest.fn(),
    displayNotification: jest.fn(),
    cancelNotification: jest.fn(),
    createTriggerNotification: jest.fn(),
  },
  AndroidCategory: { EVENT: 'event' },
  AndroidImportance: { LOW: 2, MIN: 1 },
  AndroidVisibility: { PUBLIC: 1 },
  TriggerType: { TIMESTAMP: 0 },
}));

describe('handleTimetableBridgeMessage', () => {
  beforeEach(() => {
    mockStore.clear();
    jest.clearAllMocks();
  });

  it('ignores invalid non-JSON or unrelated messages', async () => {
    const callback = jest.fn();
    expect(await handleTimetableBridgeMessage('not json', callback)).toBe(false);
    expect(await handleTimetableBridgeMessage(JSON.stringify({ type: 'otherAction' }), callback)).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  it('handles syncTimetable message and replies with success', async () => {
    const callback = jest.fn();
    const message = JSON.stringify({
      type: 'syncTimetable',
      requestId: 'req_123',
      payload: {
        courses: [
          {
            id: 1,
            title: '컴퓨터네트워크',
            professor: '박교수',
            meetings: [
              {
                id: 1,
                day: 'MONDAY',
                startTime: '10:30',
                endTime: '11:45',
                location: '7호관 204호',
              },
            ],
          },
        ],
      },
    });

    const handled = await handleTimetableBridgeMessage(message, callback);
    expect(handled).toBe(true);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'syncTimetableResult',
        requestId: 'req_123',
        success: true,
        data: expect.objectContaining({
          savedCount: 1,
        }),
      })
    );
  });

  it('handles getTimetableNowBarSettings and replies with settings', async () => {
    const callback = jest.fn();
    const message = JSON.stringify({
      type: 'getTimetableNowBarSettings',
      requestId: 'req_settings',
    });

    const handled = await handleTimetableBridgeMessage(message, callback);
    expect(handled).toBe(true);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'getTimetableNowBarSettingsResult',
        requestId: 'req_settings',
        success: true,
        data: expect.objectContaining({
          enabled: true,
          leadTimeMinutes: 15,
        }),
      })
    );
  });

  it('handles setTimetableNowBarSettings and updates settings', async () => {
    const callback = jest.fn();
    const message = JSON.stringify({
      type: 'setTimetableNowBarSettings',
      requestId: 'req_set',
      payload: {
        leadTimeMinutes: 20,
      },
    });

    const handled = await handleTimetableBridgeMessage(message, callback);
    expect(handled).toBe(true);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'setTimetableNowBarSettingsResult',
        requestId: 'req_set',
        success: true,
        data: expect.objectContaining({
          settings: expect.objectContaining({
            leadTimeMinutes: 20,
          }),
        }),
      })
    );
  });

  it('handles testTimetableNowBar for immediate developer preview', async () => {
    const callback = jest.fn();
    const message = JSON.stringify({
      type: 'testTimetableNowBar',
      payload: {
        title: '미리보기 강의',
        location: '자연대 101호',
      },
    });

    const handled = await handleTimetableBridgeMessage(message, callback);
    expect(handled).toBe(true);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'testTimetableNowBarResult',
        success: true,
        data: { active: true },
      })
    );
  });

  it('handles cancelTimetableNowBar to dismiss active ongoing notification', async () => {
    const callback = jest.fn();
    const message = JSON.stringify({
      type: 'cancelTimetableNowBar',
    });

    const handled = await handleTimetableBridgeMessage(message, callback);
    expect(handled).toBe(true);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cancelTimetableNowBarResult',
        success: true,
        data: { active: false },
      })
    );
  });
});
