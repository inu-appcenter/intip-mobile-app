import { describe, it, expect, jest } from '@jest/globals';
import {
  getDayFromDate,
  parseMeetingTime,
  getMeetingsForDate,
  getCurrentActivityState,
  getNextTransitionTimestamp,
} from '../timetableScheduler';
import { TimetableCourseItem } from '../types';

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
});
