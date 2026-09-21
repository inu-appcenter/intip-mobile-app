import notifee, {
  TriggerType,
  TimestampTrigger,
  AndroidImportance,
} from '@notifee/react-native';
import {
  TimetableActivityState,
  TimetableCourseItem,
  TimetableDay,
} from './types';
import { TimetableStorage } from './timetableStorage';
import { TimetableNowBarService, TIMETABLE_CHANNEL_ID } from './timetableNowBarService';

const DAYS_MAP: TimetableDay[] = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];

export const TIMETABLE_TRIGGER_NOTIFICATION_ID = 'timetable_nowbar_trigger';

/**
 * Date 객체에서 TimetableDay 추출
 */
export function getDayFromDate(date: Date): TimetableDay {
  return DAYS_MAP[date.getDay()];
}

/**
 * "HH:mm" 형태의 시간을 기준 날짜의 timestamp(ms)로 변환
 */
export function parseMeetingTime(date: Date, timeStr: string): number {
  const [hoursStr, minutesStr] = timeStr.split(':');
  const hours = parseInt(hoursStr, 10) || 0;
  const minutes = parseInt(minutesStr, 10) || 0;
  const d = new Date(date);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

export interface FlattenedMeeting {
  courseTitle: string;
  professor?: string | null;
  location?: string | null;
  day: TimetableDay;
  startMs: number;
  endMs: number;
}

/**
 * 특정 날짜에 해당하는 모든 수업 미팅을 시간순으로 정렬하여 반환
 */
export function getMeetingsForDate(
  courses: TimetableCourseItem[],
  date: Date
): FlattenedMeeting[] {
  const currentDay = getDayFromDate(date);
  const result: FlattenedMeeting[] = [];

  for (const course of courses) {
    if (!course.meetings || !Array.isArray(course.meetings)) continue;
    for (const meeting of course.meetings) {
      if (meeting.day === currentDay && meeting.startTime && meeting.endTime) {
        result.push({
          courseTitle: course.title,
          professor: course.professor,
          location: meeting.location,
          day: meeting.day,
          startMs: parseMeetingTime(date, meeting.startTime),
          endMs: parseMeetingTime(date, meeting.endTime),
        });
      }
    }
  }

  return result.sort((a, b) => a.startMs - b.startMs);
}

/**
 * 기준 시각(now)에 따른 현재 수업 진행 상태(Upcoming, Ongoing, None) 계산 (Pure function)
 */
export function getCurrentActivityState(
  courses: TimetableCourseItem[],
  now: Date,
  leadTimeMinutes = 15
): TimetableActivityState {
  const nowMs = now.getTime();
  const todayMeetings = getMeetingsForDate(courses, now);
  const leadMs = leadTimeMinutes * 60 * 1000;

  // 1. 현재 수업 중(ONGOING)인 미팅 우선 탐색
  for (const m of todayMeetings) {
    if (nowMs >= m.startMs && nowMs < m.endMs) {
      const duration = Math.max(1, Math.round((m.endMs - m.startMs) / (60 * 1000)));
      const elapsed = Math.max(0, Math.round((nowMs - m.startMs) / (60 * 1000)));
      return {
        phase: 'ONGOING',
        courseTitle: m.courseTitle,
        location: m.location ?? undefined,
        professor: m.professor ?? undefined,
        startTimestamp: m.startMs,
        endTimestamp: m.endMs,
        durationMinutes: duration,
        elapsedMinutes: elapsed,
      };
    }
  }

  // 2. 곧 시작할(UPCOMING, leadTime 이내) 미팅 탐색
  for (const m of todayMeetings) {
    const leadStartMs = m.startMs - leadMs;
    if (nowMs >= leadStartMs && nowMs < m.startMs) {
      return {
        phase: 'UPCOMING',
        courseTitle: m.courseTitle,
        location: m.location ?? undefined,
        professor: m.professor ?? undefined,
        startTimestamp: m.startMs,
        endTimestamp: m.endMs,
      };
    }
  }

  return { phase: 'NONE' };
}

/**
 * 다음 상태 전이(알람을 깨워야 하는 시점) 타임스탬프 계산 (Pure function)
 */
export function getNextTransitionTimestamp(
  courses: TimetableCourseItem[],
  now: Date,
  leadTimeMinutes = 15
): number | null {
  const nowMs = now.getTime();
  const leadMs = leadTimeMinutes * 60 * 1000;
  const todayMeetings = getMeetingsForDate(courses, now);

  const transitionPoints: number[] = [];

  for (const m of todayMeetings) {
    const leadStartMs = m.startMs - leadMs;
    if (leadStartMs > nowMs) transitionPoints.push(leadStartMs);
    if (m.startMs > nowMs) transitionPoints.push(m.startMs);
    if (m.endMs > nowMs) transitionPoints.push(m.endMs);
  }

  if (transitionPoints.length === 0) {
    return null;
  }

  transitionPoints.sort((a, b) => a - b);
  return transitionPoints[0];
}

export const TimetableScheduler = {
  /**
   * 현재 시각 기준 시간표 상태를 평가하여 Notifee Ongoing Notification을 갱신하고
   * 다음 상태 전이 시점에 정확한 알람(Trigger)을 예약
   */
  async syncSchedule(targetDate: Date = new Date()): Promise<TimetableActivityState> {
    const settings = await TimetableStorage.getSettings();
    if (!settings.enabled) {
      await TimetableNowBarService.cancel();
      return { phase: 'NONE' };
    }

    const data = await TimetableStorage.getTimetableData();
    if (!data || !data.courses || data.courses.length === 0) {
      await TimetableNowBarService.cancel();
      return { phase: 'NONE' };
    }

    const state = getCurrentActivityState(data.courses, targetDate, settings.leadTimeMinutes);

    // 알림 표시 또는 취소
    if (state.phase === 'NONE') {
      await TimetableNowBarService.cancel();
    } else {
      await TimetableNowBarService.renderActivity(state);
    }

    // 다음 전환 시점 계산 및 알람 등록
    const nextMs = getNextTransitionTimestamp(data.courses, targetDate, settings.leadTimeMinutes);
    if (nextMs && nextMs > Date.now()) {
      await this.scheduleNextAlarm(nextMs);
    }

    return state;
  },

  /**
   * 다음 상태 변경 시점에 앱을 깨우도록 Notifee TimestampTrigger 등록
   */
  async scheduleNextAlarm(targetTimestamp: number): Promise<void> {
    try {
      await notifee.cancelNotification(TIMETABLE_TRIGGER_NOTIFICATION_ID);

      const trigger: TimestampTrigger = {
        type: TriggerType.TIMESTAMP,
        timestamp: targetTimestamp,
      };

      // silent trigger notification: 도래 시 백그라운드 이벤트에서 syncSchedule 호출
      await notifee.createTriggerNotification(
        {
          id: TIMETABLE_TRIGGER_NOTIFICATION_ID,
          title: '시간표 상태 갱신',
          body: '',
          android: {
            channelId: TIMETABLE_CHANNEL_ID,
            importance: AndroidImportance.MIN,
            autoCancel: true,
          },
        },
        trigger
      );
    } catch (e) {
      console.warn('[TimetableScheduler] 다음 알람 예약 실패:', e);
    }
  },
};
