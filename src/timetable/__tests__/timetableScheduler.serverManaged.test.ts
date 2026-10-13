import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { TimetableScheduler } from '../timetableScheduler';

const mockCancel = jest.fn(async () => {});
const mockRender = jest.fn(async () => {});
let mockRegistered = false;
let mockTimetable: any = null;

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: { cancelNotification: jest.fn(async () => {}), createTriggerNotification: jest.fn(async () => {}) },
  AndroidImportance: { MIN: 1 },
  TriggerType: { TIMESTAMP: 0 },
}));

jest.mock('../timetableNowBarService', () => ({
  TIMETABLE_CHANNEL_ID: 'test',
  TimetableNowBarService: {
    cancel: () => mockCancel(),
    renderActivity: (...args: any[]) => (mockRender as any)(...args),
    onCancel: () => () => {},
  },
}));

jest.mock('../liveActivityPushToStart', () => ({
  isLiveActivityPushToStartRegistered: async () => mockRegistered,
}));

jest.mock('../timetableStorage', () => ({
  TimetableStorage: {
    getSettings: async () => ({ enabled: true, leadTimeMinutes: 10 }),
    getTestActivity: async () => null,
    getTimetableData: async () => mockTimetable,
  },
}));


describe('syncSchedule with an empty local timetable', () => {
  beforeEach(() => {
    mockCancel.mockClear();
    mockRender.mockClear();
    mockTimetable = null;
  });

  it('leaves server-managed Live Activities alone', async () => {
    // 운영 웹은 syncTimetable 브리지를 보내지 않아 로컬 시간표가 비어 있다. 서버가 push-to-start로
    // 시작한 Activity를 앱이 깨어나자마자 끄면 안 된다.
    mockRegistered = true;
    expect(await TimetableScheduler.syncSchedule()).toEqual({ phase: 'NONE' });
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('still clears the app-managed ones (no push-to-start registration)', async () => {
    mockRegistered = false;
    await TimetableScheduler.syncSchedule();
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  it('treats an empty course list the same as no data', async () => {
    mockRegistered = true;
    mockTimetable = { updatedAt: Date.now(), courses: [] };
    await TimetableScheduler.syncSchedule();
    expect(mockCancel).not.toHaveBeenCalled();
  });
});
