import { describe, it, expect, jest, afterEach } from '@jest/globals';
import {
  getDayFromDate,
  parseMeetingTime,
  getMeetingsForDate,
  getCurrentActivityState,
  getNextTransitionTimestamp,
  TimetableScheduler,
} from '../timetableScheduler';
import { TimetableCourseItem } from '../types';

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    createChannel: jest.fn(),
    displayNotification: jest.fn(),
    cancelNotification: jest.fn(),
    createTriggerNotification: jest.fn(),
    stopForegroundService: jest.fn(),
  },
  AndroidCategory: { EVENT: 'event', PROGRESS: 'progress' },
  AndroidImportance: { DEFAULT: 3, LOW: 2, MIN: 1 },
  AndroidStyle: { BIGTEXT: 1 },
  AndroidVisibility: { PUBLIC: 1 },
  TriggerType: { TIMESTAMP: 0 },
}));

describe('timetableScheduler unit tests', () => {
  const sampleCourses: TimetableCourseItem[] = [
    {
      id: 1,
      title: '운영체제',
      professor: '홍길동',
      meetings: [
        {
          id: 101,
          day: 'MONDAY',
          startTime: '09:00',
          endTime: '10:15',
          location: '7호관 314호',
        },
        {
          id: 102,
          day: 'WEDNESDAY',
          startTime: '09:00',
          endTime: '10:15',
          location: '7호관 314호',
        },
      ],
    },
    {
      id: 2,
      title: '자료구조',
      professor: '김철수',
      meetings: [
        {
          id: 201,
          day: 'MONDAY',
          startTime: '13:00',
          endTime: '14:30',
          location: '정보관 201호',
        },
      ],
    },
  ];

  describe('getDayFromDate', () => {
    it('returns correct TimetableDay for known dates', () => {
      // 2026-09-21 is a Monday
      const monday = new Date(2026, 8, 21, 10, 0, 0);
      expect(getDayFromDate(monday)).toBe('MONDAY');

      // 2026-09-23 is a Wednesday
      const wednesday = new Date(2026, 8, 23, 10, 0, 0);
      expect(getDayFromDate(wednesday)).toBe('WEDNESDAY');

      // 2026-09-27 is a Sunday
      const sunday = new Date(2026, 8, 27, 10, 0, 0);
      expect(getDayFromDate(sunday)).toBe('SUNDAY');
    });
  });

  describe('parseMeetingTime', () => {
    it('sets correct hour and minute on reference date', () => {
      const base = new Date(2026, 8, 21, 0, 0, 0);
      const parsed = parseMeetingTime(base, '09:30');
      const d = new Date(parsed);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(8);
      expect(d.getDate()).toBe(21);
      expect(d.getHours()).toBe(9);
      expect(d.getMinutes()).toBe(30);
    });
  });

  describe('getMeetingsForDate', () => {
    it('extracts and sorts meetings for Monday', () => {
      const monday = new Date(2026, 8, 21, 8, 0, 0);
      const meetings = getMeetingsForDate(sampleCourses, monday);
      expect(meetings).toHaveLength(2);
      expect(meetings[0].courseTitle).toBe('운영체제');
      expect(meetings[1].courseTitle).toBe('자료구조');
    });

    it('returns empty array when there are no classes on Sunday', () => {
      const sunday = new Date(2026, 8, 27, 10, 0, 0);
      const meetings = getMeetingsForDate(sampleCourses, sunday);
      expect(meetings).toHaveLength(0);
    });
  });

  describe('getCurrentActivityState', () => {
    const monday = new Date(2026, 8, 21);

    it('returns NONE when long before class (e.g. 08:30 with 15min lead)', () => {
      const now = new Date(monday);
      now.setHours(8, 30, 0, 0);
      const state = getCurrentActivityState(sampleCourses, now, 15);
      expect(state.phase).toBe('NONE');
    });

    it('returns UPCOMING 10 minutes before class start (08:50 for 09:00 class)', () => {
      const now = new Date(monday);
      now.setHours(8, 50, 0, 0);
      const state = getCurrentActivityState(sampleCourses, now, 15);
      expect(state.phase).toBe('UPCOMING');
      expect(state.courseTitle).toBe('운영체제');
      expect(state.location).toBe('7호관 314호');
      expect(state.startTimestamp).toBeDefined();
    });

    it('returns ONGOING during class (09:30 for 09:00~10:15 class)', () => {
      const now = new Date(monday);
      now.setHours(9, 30, 0, 0);
      const state = getCurrentActivityState(sampleCourses, now, 15);
      expect(state.phase).toBe('ONGOING');
      expect(state.courseTitle).toBe('운영체제');
      expect(state.location).toBe('7호관 314호');
      expect(state.durationMinutes).toBe(75);
      expect(state.elapsedMinutes).toBe(30);
    });

    it('returns NONE between classes (11:00)', () => {
      const now = new Date(monday);
      now.setHours(11, 0, 0, 0);
      const state = getCurrentActivityState(sampleCourses, now, 15);
      expect(state.phase).toBe('NONE');
    });

    it('returns UPCOMING for afternoon class (12:50 for 13:00 class)', () => {
      const now = new Date(monday);
      now.setHours(12, 50, 0, 0);
      const state = getCurrentActivityState(sampleCourses, now, 15);
      expect(state.phase).toBe('UPCOMING');
      expect(state.courseTitle).toBe('자료구조');
      expect(state.location).toBe('정보관 201호');
    });

    it('returns NONE after all classes have ended (15:00)', () => {
      const now = new Date(monday);
      now.setHours(15, 0, 0, 0);
      const state = getCurrentActivityState(sampleCourses, now, 15);
      expect(state.phase).toBe('NONE');
    });
  });

  describe('getNextTransitionTimestamp', () => {
    const monday = new Date(2026, 8, 21);

    it('returns the lead start time (08:45) when called at 08:00', () => {
      const now = new Date(monday);
      now.setHours(8, 0, 0, 0);
      const nextMs = getNextTransitionTimestamp(sampleCourses, now, 15);
      expect(nextMs).not.toBeNull();
      const nextDate = new Date(nextMs!);
      expect(nextDate.getHours()).toBe(8);
      expect(nextDate.getMinutes()).toBe(45);
    });

    it('returns the class start time (09:00) when called at 08:50', () => {
      const now = new Date(monday);
      now.setHours(8, 50, 0, 0);
      const nextMs = getNextTransitionTimestamp(sampleCourses, now, 15);
      expect(nextMs).not.toBeNull();
      const nextDate = new Date(nextMs!);
      expect(nextDate.getHours()).toBe(9);
      expect(nextDate.getMinutes()).toBe(0);
    });

    it('returns the class end time (10:15) when called at 09:30', () => {
      const now = new Date(monday);
      now.setHours(9, 30, 0, 0);
      const nextMs = getNextTransitionTimestamp(sampleCourses, now, 15);
      expect(nextMs).not.toBeNull();
      const nextDate = new Date(nextMs!);
      expect(nextDate.getHours()).toBe(10);
      expect(nextDate.getMinutes()).toBe(15);
    });

    it('returns null when all transition points for today have passed', () => {
      const now = new Date(monday);
      now.setHours(16, 0, 0, 0);
      const nextMs = getNextTransitionTimestamp(sampleCourses, now, 15);
      expect(nextMs).toBeNull();
    });
  });

  describe('progressTicker lifecycle', () => {
    afterEach(() => {
      TimetableScheduler.stopProgressTicker();
      jest.useRealTimers();
    });

    it('starts and stops progress ticker cleanly without errors', async () => {
      jest.useFakeTimers();
      const syncSpy = jest.spyOn(TimetableScheduler, 'syncSchedule').mockResolvedValue({ phase: 'NONE' });

      TimetableScheduler.startProgressTicker();
      jest.advanceTimersByTime(65 * 1000);
      expect(syncSpy).toHaveBeenCalled();

      TimetableScheduler.stopProgressTicker();
      syncSpy.mockRestore();
    });

    it('starts progress ticker with millisecond precision to next minute', () => {
      jest.useFakeTimers();
      const syncSpy = jest.spyOn(TimetableScheduler, 'syncSchedule').mockResolvedValue({ phase: 'NONE' });

      TimetableScheduler.startProgressTicker();
      jest.advanceTimersByTime(65 * 1000);
      expect(syncSpy).toHaveBeenCalled();

      TimetableScheduler.stopProgressTicker();
      syncSpy.mockRestore();
    });
  });

  describe('syncSchedule ongoingEnabled and dismissal handling', () => {
    const monday = new Date(2026, 8, 21, 0, 0, 0); // Monday
    const TimetableStorage = require('../timetableStorage').TimetableStorage;
    const TimetableNowBarService = require('../timetableNowBarService').TimetableNowBarService;

    afterEach(async () => {
      await TimetableScheduler.resetDismissed();
      jest.restoreAllMocks();
    });

    it('cancels ongoing notification when ongoingEnabled is false during class', async () => {
      jest.spyOn(TimetableStorage, 'getSettings').mockResolvedValue({
        enabled: true,
        leadTimeMinutes: 10,
        ongoingEnabled: false,
      });
      jest.spyOn(TimetableStorage, 'getTestActivity').mockResolvedValue(null);
      jest.spyOn(TimetableStorage, 'getTimetableData').mockResolvedValue({
        updatedAt: Date.now(),
        courses: sampleCourses,
      });

      const cancelSpy = jest.spyOn(TimetableNowBarService, 'cancel').mockResolvedValue(undefined as any);
      const renderSpy = jest.spyOn(TimetableNowBarService, 'renderActivity').mockResolvedValue(undefined as any);

      // Monday 09:30 (during 09:00~10:15 class)
      const duringClass = new Date(monday);
      duringClass.setHours(9, 30, 0, 0);

      const result = await TimetableScheduler.syncSchedule(duringClass);
      expect(result.phase).toBe('NONE');
      expect(cancelSpy).toHaveBeenCalled();
      expect(renderSpy).not.toHaveBeenCalled();
    });

    it('renders ongoing notification when ongoingEnabled is true during class', async () => {
      jest.spyOn(TimetableStorage, 'getSettings').mockResolvedValue({
        enabled: true,
        leadTimeMinutes: 10,
        ongoingEnabled: true,
      });
      jest.spyOn(TimetableStorage, 'getTestActivity').mockResolvedValue(null);
      jest.spyOn(TimetableStorage, 'getTimetableData').mockResolvedValue({
        updatedAt: Date.now(),
        courses: sampleCourses,
      });
      jest.spyOn(TimetableStorage, 'getDismissedSessionKey').mockResolvedValue(null);

      const renderSpy = jest.spyOn(TimetableNowBarService, 'renderActivity').mockResolvedValue(undefined as any);

      const duringClass = new Date(monday);
      duringClass.setHours(9, 30, 0, 0);

      const result = await TimetableScheduler.syncSchedule(duringClass);
      expect(result.phase).toBe('ONGOING');
      expect(renderSpy).toHaveBeenCalled();
    });

    it('skips rendering when current session is marked as dismissed by user', async () => {
      jest.spyOn(TimetableStorage, 'getSettings').mockResolvedValue({
        enabled: true,
        leadTimeMinutes: 15,
        ongoingEnabled: true,
      });
      jest.spyOn(TimetableStorage, 'getTestActivity').mockResolvedValue(null);
      jest.spyOn(TimetableStorage, 'getTimetableData').mockResolvedValue({
        updatedAt: Date.now(),
        courses: sampleCourses,
      });

      const preClass = new Date(monday);
      preClass.setHours(8, 50, 0, 0); // 10 mins before 09:00 class
      const classStartMs = new Date(monday);
      classStartMs.setHours(9, 0, 0, 0);
      const sessionKey = `운영체제_${classStartMs.getTime()}`;

      // Mark session as dismissed
      jest.spyOn(TimetableStorage, 'getDismissedSessionKey').mockResolvedValue(sessionKey);

      const renderSpy = jest.spyOn(TimetableNowBarService, 'renderActivity').mockResolvedValue(undefined as any);

      await TimetableScheduler.syncSchedule(preClass);
      expect(renderSpy).not.toHaveBeenCalled();
    });

    it('resets dismissed state and restores rendering when resumed from app (fromAppResume)', async () => {
      jest.spyOn(TimetableStorage, 'getSettings').mockResolvedValue({
        enabled: true,
        leadTimeMinutes: 15,
        ongoingEnabled: true,
      });
      jest.spyOn(TimetableStorage, 'getTestActivity').mockResolvedValue(null);
      jest.spyOn(TimetableStorage, 'getTimetableData').mockResolvedValue({
        updatedAt: Date.now(),
        courses: sampleCourses,
      });

      const preClass = new Date(monday);
      preClass.setHours(8, 50, 0, 0);

      const resetSpy = jest.spyOn(TimetableScheduler, 'resetDismissed');
      const renderSpy = jest.spyOn(TimetableNowBarService, 'renderActivity').mockResolvedValue(undefined as any);

      await TimetableScheduler.syncSchedule(preClass, { fromAppResume: true });
      expect(resetSpy).toHaveBeenCalled();
      expect(renderSpy).toHaveBeenCalled();
    });
  });
});
