import { Platform } from 'react-native';
import notifee, {
  AndroidCategory,
  AndroidImportance,
  AndroidVisibility,
} from '@notifee/react-native';
import { TimetableActivityState } from './types';

export const TIMETABLE_CHANNEL_ID = 'timetable_nowbar';
export const TIMETABLE_ONGOING_NOTIFICATION_ID = 'timetable_ongoing_activity';

export const TimetableNowBarService = {
  /**
   * 알림 채널 생성 (무음, 진동 없음, 방해 금지)
   */
  async ensureChannel(): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
      await notifee.createChannel({
        id: TIMETABLE_CHANNEL_ID,
        name: '실시간 시간표 (나우 바/잠금화면)',
        description: '수업 전후 및 진행 중 실시간 시간표 및 남은 시간 표시',
        importance: AndroidImportance.LOW, // 소리 및 팝업 헤드업 배너 없이 조용히 잠금화면에 상주
        sound: undefined,
        vibration: false,
        lights: false,
        badge: false,
      });
    } catch (e) {
      console.warn('[TimetableNowBarService] 채널 생성 실패:', e);
    }
  },

  /**
   * 현재 수업 상태를 기반으로 Ongoing Notification / Now Bar 렌더링
   */
  async renderActivity(state: TimetableActivityState): Promise<void> {
    if (state.phase === 'NONE') {
      await this.cancel();
      return;
    }

    await this.ensureChannel();

    const isUpcoming = state.phase === 'UPCOMING';
    const targetTimestamp = isUpcoming ? state.startTimestamp : state.endTimestamp;

    const title = isUpcoming
      ? `다음 수업: ${state.courseTitle}`
      : `${state.courseTitle} (수업 중)`;

    const subtitle = state.location || (isUpcoming ? '수업 준비' : '수업 진행 중');
    const body = isUpcoming
      ? `${subtitle} · 수업 시작까지`
      : `${subtitle} · 수업 종료까지`;

    try {
      await notifee.displayNotification({
        id: TIMETABLE_ONGOING_NOTIFICATION_ID,
        title,
        subtitle,
        body,
        data: {
          type: 'timetable_nowbar',
          path: '/timetable',
          phase: state.phase,
          courseTitle: state.courseTitle || '',
          location: state.location || '',
        },
        android: {
          channelId: TIMETABLE_CHANNEL_ID,
          category: AndroidCategory.EVENT,
          ongoing: true, // 사용자가 스와이프로 임의 종료 불가
          autoCancel: false,
          onlyAlertOnce: true,
          visibility: AndroidVisibility.PUBLIC,
          showChronometer: !!targetTimestamp,
          chronometerDirection: 'down',
          timestamp: targetTimestamp,
          progress: !isUpcoming && state.durationMinutes
            ? {
                max: Math.max(1, state.durationMinutes),
                current: Math.min(state.durationMinutes, state.elapsedMinutes || 0),
                indeterminate: false,
              }
            : undefined,
          actions: [
            {
              title: '시간표 확인',
              pressAction: {
                id: 'default',
              },
            },
          ],
          pressAction: {
            id: 'default',
          },
        },
      });
    } catch (e) {
      console.error('[TimetableNowBarService] 알림 렌더링 실패:', e);
    }
  },

  /**
   * Ongoing 알림 취소 및 제거
   */
  async cancel(): Promise<void> {
    try {
      await notifee.cancelNotification(TIMETABLE_ONGOING_NOTIFICATION_ID);
    } catch (e) {
      console.warn('[TimetableNowBarService] 알림 취소 실패:', e);
    }
  },
};
