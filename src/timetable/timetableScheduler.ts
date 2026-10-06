import { Platform } from 'react-native';
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
import { isLiveActivityPushToStartRegistered } from './liveActivityPushToStart';
import { IntipAndroidLiveUpdate } from '../../modules/intip-android-live-update';

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

// iOS 전용 상태 전이 타이머 (scheduleNextAlarm 참고)
let iosTransitionTimer: ReturnType<typeof setTimeout> | null = null;
// 실시간 진행률(Progress Bar) 1분 주기 자동 갱신 타이머
let progressTickerTimer: ReturnType<typeof setTimeout> | null = null;

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
   * 실시간 진행률(Progress Bar) 1분 주기 자동 갱신 타이머 중지
   */
  stopProgressTicker(): void {
    if (progressTickerTimer) {
      clearTimeout(progressTickerTimer);
      progressTickerTimer = null;
    }
  },

  /**
   * 실시간 진행률(Progress Bar) 1분 주기 자동 갱신 타이머 시작
   * - 매 분 00초 정각 주기에 맞춰 다음 갱신 시간을 예약함으로써 부드럽게 1분 단위로 진행 바 갱신
   */
  startProgressTicker(customDelayMs?: number): void {
    this.stopProgressTicker();

    // Android 16+ One UI 8 LiveUpdate(나우 바)를 지원하는 기기에서는
    // 네이티브 AlarmManager가 Doze/백그라운드에서도 정확하게 1분 단위 갱신을 전담하므로
    // 백그라운드에서 지연 및 자원 낭비를 유발하는 JS setTimeout 중복 루프를 방지합니다.
    if (Platform.OS === 'android' && IntipAndroidLiveUpdate.isSupported()) {
      return;
    }

    const now = new Date();
    const seconds = now.getSeconds();
    const msToNextMinute = Math.max(1000, (60 - seconds) * 1000);
    const delay =
      customDelayMs !== undefined && customDelayMs > 0
        ? Math.min(msToNextMinute, Math.max(500, customDelayMs))
        : msToNextMinute;

    progressTickerTimer = setTimeout(async () => {
      try {
        const state = await this.syncSchedule();
        if (state.phase !== 'NONE') {
          this.startProgressTicker();
        }
      } catch (e) {
        console.warn('[TimetableScheduler] 진행률 주기 갱신 에러:', e);
        this.startProgressTicker();
      }
    }, delay);
  },

  /**
   * 현재 시각 기준 시간표 상태를 평가하여 Notifee Ongoing Notification을 갱신하고
   * 다음 상태 전이 시점에 정확한 알람(Trigger)을 예약
   */
  async syncSchedule(targetDate: Date = new Date()): Promise<TimetableActivityState> {
    const settings = await TimetableStorage.getSettings();
    if (!settings.enabled) {
      await TimetableNowBarService.cancel();
      this.stopProgressTicker();
      return { phase: 'NONE' };
    }

    // 1. 진행 중인 테스트 액티비티가 있으면 우선 유지 및 렌더링
    const testActivity = await TimetableStorage.getTestActivity();
    if (testActivity && testActivity.phase !== 'NONE') {
      const now = targetDate.getTime();
      // 종료 시점 도달 시 자동 종료
      if (testActivity.endTimestamp && now >= testActivity.endTimestamp) {
        await TimetableStorage.clearTestActivity();
        await TimetableNowBarService.cancel();
        this.stopProgressTicker();
        return { phase: 'NONE' };
      }
      // 수업 전(UPCOMING) 상태에서 수업 시작 시각 도달 시 수업 중(ONGOING)으로 자연스럽게 전환
      if (
        testActivity.phase === 'UPCOMING' &&
        testActivity.startTimestamp &&
        now >= testActivity.startTimestamp
      ) {
        testActivity.phase = 'ONGOING';
        await TimetableStorage.saveTestActivity(testActivity);
      }
      await TimetableNowBarService.renderActivity(testActivity);

      // 다음 상태 전환 시점이 있으면 그 시점에 바로 맞춰서 스케줄링 (화면 꺼짐 시 AlarmManager도 함께 등록)
      let nextTransitionDelay: number | undefined;
      const nowMs = Date.now();
      if (testActivity.phase === 'UPCOMING' && testActivity.startTimestamp && testActivity.startTimestamp > nowMs) {
        nextTransitionDelay = testActivity.startTimestamp - nowMs + 100;
      } else if (testActivity.endTimestamp && testActivity.endTimestamp > nowMs) {
        nextTransitionDelay = testActivity.endTimestamp - nowMs + 100;
      }

      if (nextTransitionDelay && nextTransitionDelay > 0) {
        await this.scheduleNextAlarm(nowMs + nextTransitionDelay).catch(() => {});
      }
      this.startProgressTicker(nextTransitionDelay);
      return testActivity;
    }

    const data = await TimetableStorage.getTimetableData();
    if (!data || !data.courses || data.courses.length === 0) {
      await TimetableNowBarService.cancel();
      this.stopProgressTicker();
      return { phase: 'NONE' };
    }

    const state = getCurrentActivityState(data.courses, targetDate, settings.leadTimeMinutes);

    // 알림 표시 또는 취소
    // iOS에서 push-to-start가 등록된 기기는 서버가 Live Activity의 시작(UPCOMING)·갱신·종료를 맡는다.
    // 앱은 떠 있는 것이 없을 때 ONGOING만 시작하고, 떠 있는 것은 덮어쓰거나 끝내지 않는다.
    const serverManaged = await isLiveActivityPushToStartRegistered();
    if (state.phase === 'NONE') {
      if (!serverManaged) await TimetableNowBarService.cancel();
      this.stopProgressTicker();
    } else {
      await TimetableNowBarService.renderActivity(state, {
        startUpcoming: !serverManaged,
        leaveExisting: serverManaged,
      });
      this.startProgressTicker();
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
    // iOS는 로컬 알림이 도착해도 백그라운드/종료 상태의 앱 JS를 깨우지 않고,
    // 포그라운드에서는 "시간표 상태 갱신" 배너가 그대로 사용자에게 보인다.
    // 게다가 Live Activity 시작(Activity.request)은 포그라운드에서만 가능하므로
    // 포그라운드용 JS 타이머로 대신한다. 백그라운드 동안은 JS가 멈추지만, 복귀 시
    // AppState 'active'에서 syncSchedule이 다시 돈다.
    if (Platform.OS === 'ios') {
      if (iosTransitionTimer) clearTimeout(iosTransitionTimer);
      // 이전 버전이 예약해 둔 트리거 알림 정리
      await notifee.cancelNotification(TIMETABLE_TRIGGER_NOTIFICATION_ID).catch(() => {});
      iosTransitionTimer = setTimeout(
        () => {
          iosTransitionTimer = null;
          void this.syncSchedule();
        },
        Math.max(0, targetTimestamp - Date.now()) + 500,
      );
      return;
    }

    try {
      await notifee.cancelNotification(TIMETABLE_TRIGGER_NOTIFICATION_ID);

      const trigger: TimestampTrigger = {
        type: TriggerType.TIMESTAMP,
        timestamp: targetTimestamp,
      };

      // silent trigger notification: 도래 시 백그라운드 이벤트에서 syncSchedule 호출 후 즉시 자동 소멸
      await notifee.createTriggerNotification(
        {
          id: TIMETABLE_TRIGGER_NOTIFICATION_ID,
          title: '',
          body: '',
          android: {
            channelId: 'silent_background_trigger',
            importance: AndroidImportance.MIN,
            autoCancel: true,
            sound: undefined,
            vibrationPattern: [],
            badgeCount: 0,
          },
        },
        trigger
      );
    } catch (e) {
      console.warn('[TimetableScheduler] 다음 알람 예약 실패:', e);
    }
  },
};

// 알림이 취소되거나 닫힐 때 1분 주기 진행률 타이머도 함께 정리
TimetableNowBarService.onCancel(() => {
  TimetableScheduler.stopProgressTicker();
});

