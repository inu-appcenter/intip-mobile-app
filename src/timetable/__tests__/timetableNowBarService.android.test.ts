import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  TimetableNowBarService,
  TIMETABLE_NOTIFICATION_INT_ID,
  TIMETABLE_ONGOING_NOTIFICATION_ID,
} from '../timetableNowBarService';
import { IntipAndroidLiveUpdate } from '../../../modules/intip-android-live-update';
import notifee from '@notifee/react-native';
import { TimetableActivityState } from '../types';

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    createChannel: jest.fn(async () => {}),
    deleteChannel: jest.fn(async () => {}),
    displayNotification: jest.fn(async () => {}),
    cancelNotification: jest.fn(async () => {}),
    stopForegroundService: jest.fn(async () => {}),
  },
  AndroidCategory: { EVENT: 'event', PROGRESS: 'progress' },
  AndroidImportance: { DEFAULT: 3 },
  AndroidStyle: { BIGTEXT: 1 },
  AndroidVisibility: { PUBLIC: 1 },
}));

const mockLiveUpdate = IntipAndroidLiveUpdate as unknown as {
  isSupported: jest.Mock;
  canPostPromoted: jest.Mock;
  startOrUpdateLiveUpdate: jest.Mock;
  stopLiveUpdate: jest.Mock;
};

const mockNotifee = notifee as unknown as {
  displayNotification: jest.Mock;
  cancelNotification: jest.Mock;
  stopForegroundService: jest.Mock;
};

describe('TimetableNowBarService (Android Live Update & Samsung Now Bar)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Android 16+ (One UI 8) with Live Update API support', () => {
    beforeEach(() => {
      mockLiveUpdate.isSupported.mockReturnValue(true);
    });

    it('renders LiveUpdate with timer and independent progress bar for UPCOMING phase', async () => {
      const state: TimetableActivityState = {
        phase: 'UPCOMING',
        courseTitle: '알고리즘',
        location: '정보기술대학 208호',
        professor: '김교수',
        startTimestamp: Date.now() + 10 * 60 * 1000,
        endTimestamp: Date.now() + 85 * 60 * 1000,
        durationMinutes: 75,
      };

      await TimetableNowBarService.renderActivity(state);

      expect(mockLiveUpdate.startOrUpdateLiveUpdate).toHaveBeenCalledTimes(1);
      const call = mockLiveUpdate.startOrUpdateLiveUpdate.mock.calls[0][0] as any;
      expect(call.title).toBe('[다음 수업] 알고리즘');
      expect(call.text).toContain('정보기술대학 208호 · 김교수');
      expect(call.shortCriticalText).toBe('수업 전');
      expect(call.showChronometer).toBe(false);
      expect(call.targetTimestamp).toBe(state.startTimestamp);
      expect(typeof call.progress).toBe('number');
      expect(call.progress).toBeGreaterThanOrEqual(0);
      expect(call.progress).toBeLessThanOrEqual(100);
      expect(call.segments).toEqual([{ length: 100, color: '#5B8DEF' }]);
      expect(call.ongoing).toBe(true);
      // Notifee는 폴백이므로 호출되지 않아야 함
      expect(mockNotifee.displayNotification).not.toHaveBeenCalled();
    });

    it('renders LiveUpdate with "수업 중" Status Chip and independent class progress for IN_CLASS phase', async () => {
      const now = Date.now();
      const state: TimetableActivityState = {
        phase: 'IN_CLASS',
        courseTitle: '데이터베이스',
        location: '자연대 101호',
        startTimestamp: now - 30 * 60 * 1000, // 30분 경과
        endTimestamp: now + 45 * 60 * 1000, // 총 75분
        durationMinutes: 75,
        elapsedMinutes: 30,
      };

      await TimetableNowBarService.renderActivity(state);

      expect(mockLiveUpdate.startOrUpdateLiveUpdate).toHaveBeenCalledTimes(1);
      const call = mockLiveUpdate.startOrUpdateLiveUpdate.mock.calls[0][0] as any;
      expect(call.title).toBe('[수업 중] 데이터베이스');
      expect(call.text).toContain('자연대 101호');
      expect(call.shortCriticalText).toBe('수업 중');
      expect(call.showChronometer).toBe(false);
      expect(call.targetTimestamp).toBeUndefined();
      expect(call.progress).toBe(40); // 30 / 75 = 40%
      expect(call.segments).toEqual([{ length: 100, color: '#043799' }]);
      expect(mockNotifee.displayNotification).not.toHaveBeenCalled();
    });

    it('cancels both native live update and notifee services on cancel()', async () => {
      await TimetableNowBarService.cancel();

      expect(mockLiveUpdate.stopLiveUpdate).toHaveBeenCalledWith(TIMETABLE_NOTIFICATION_INT_ID);
      expect(mockNotifee.stopForegroundService).toHaveBeenCalledTimes(1);
      expect(mockNotifee.cancelNotification).toHaveBeenCalledWith(TIMETABLE_ONGOING_NOTIFICATION_ID);
    });
  });

  describe('Android 15 or below (Fallback to Notifee Ongoing Notification)', () => {
    beforeEach(() => {
      mockLiveUpdate.isSupported.mockReturnValue(false);
    });

    it('falls back to Notifee displayNotification when Live Update is not supported', async () => {
      const state: TimetableActivityState = {
        phase: 'UPCOMING',
        courseTitle: '자료구조',
        location: '공대 3호관',
        startTimestamp: Date.now() + 5 * 60 * 1000,
        endTimestamp: Date.now() + 80 * 60 * 1000,
      };

      await TimetableNowBarService.renderActivity(state);

      expect(mockLiveUpdate.startOrUpdateLiveUpdate).not.toHaveBeenCalled();
      expect(mockNotifee.displayNotification).toHaveBeenCalledTimes(1);
      expect(mockNotifee.displayNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          id: TIMETABLE_ONGOING_NOTIFICATION_ID,
          title: '자료구조',
          android: expect.objectContaining({
            ongoing: true,
            asForegroundService: true,
          }),
        }),
      );
    });
  });
});
