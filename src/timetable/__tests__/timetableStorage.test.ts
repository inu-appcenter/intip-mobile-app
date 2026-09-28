import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { TimetableStorage, DEFAULT_NOWBAR_SETTINGS } from '../timetableStorage';
import { TimetableCourseItem } from '../types';

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

describe('TimetableStorage', () => {
  beforeEach(() => {
    mockStore.clear();
    jest.clearAllMocks();
  });

  const dummyCourses: TimetableCourseItem[] = [
    {
      id: 1,
      title: '인공지능개론',
      professor: '이영희',
      meetings: [
        {
          id: 101,
          day: 'TUESDAY',
          startTime: '10:00',
          endTime: '11:15',
          location: '7호관 101호',
        },
      ],
    },
  ];

  it('saves and retrieves timetable data properly', async () => {
    expect(await TimetableStorage.getTimetableData()).toBeNull();

    await TimetableStorage.saveTimetableData(dummyCourses);
    const data = await TimetableStorage.getTimetableData();

    expect(data).not.toBeNull();
    expect(data?.courses).toHaveLength(1);
    expect(data?.courses[0].title).toBe('인공지능개론');
    expect(data?.courses[0].meetings[0].location).toBe('7호관 101호');
  });

  it('clears timetable data properly', async () => {
    await TimetableStorage.saveTimetableData(dummyCourses);
    expect(await TimetableStorage.getTimetableData()).not.toBeNull();

    await TimetableStorage.clearTimetableData();
    expect(await TimetableStorage.getTimetableData()).toBeNull();
  });

  it('returns default settings when none saved', async () => {
    const settings = await TimetableStorage.getSettings();
    expect(settings).toEqual(DEFAULT_NOWBAR_SETTINGS);
    expect(settings.enabled).toBe(true);
    expect(settings.leadTimeMinutes).toBe(15);
  });

  it('merges and saves updated settings', async () => {
    const updated = await TimetableStorage.saveSettings({
      leadTimeMinutes: 10,
    });
    expect(updated.enabled).toBe(true);
    expect(updated.leadTimeMinutes).toBe(10);

    const reloaded = await TimetableStorage.getSettings();
    expect(reloaded.leadTimeMinutes).toBe(10);
    expect(reloaded.enabled).toBe(true);

    const disabled = await TimetableStorage.saveSettings({
      enabled: false,
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.leadTimeMinutes).toBe(10);
  });
});
