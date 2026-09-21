import { Platform } from 'react-native';
import notifee, {
  AndroidCategory,
  AndroidImportance,
  AndroidStyle,
  AndroidVisibility,
} from '@notifee/react-native';
import { TimetableActivityState } from './types';
import { TimetableLiveActivity, TimetableLiveActivityProps } from '../widgets/TimetableLiveActivity';

export const TIMETABLE_CHANNEL_ID = 'timetable_nowbar_v2';
export const TIMETABLE_ONGOING_NOTIFICATION_ID = 'timetable_ongoing_activity';

export const TimetableNowBarService = {
  /**
   * 알림 채널 생성 (Android 전용: 소리/진동 없이 잠금화면 및 상태바에 당당히 상주하도록 DEFAULT 중요도 적용)
   */
  async ensureChannel(): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
      // 구 채널 정리
      await notifee.deleteChannel('timetable_nowbar').catch(() => {});

      await notifee.createChannel({
        id: TIMETABLE_CHANNEL_ID,
        name: '실시간 시간표 (나우 바/잠금화면)',
        description: '수업 전후 및 진행 중 실시간 시간표 및 남은 시간 표시',
        importance: AndroidImportance.DEFAULT, // DEFAULT 중요도여야 잠금화면 실시간 카드 및 상단 상태표시줄 칩으로 승격됨
        visibility: AndroidVisibility.PUBLIC, // 잠금화면 및 AOD에 내용 전체 표시
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
   * 현재 수업 상태를 기반으로 Ongoing Notification / Now Bar / Dynamic Island 렌더링
   */
  async renderActivity(state: TimetableActivityState): Promise<void> {
    if (state.phase === 'NONE') {
      await this.cancel();
      return;
    }

    const isUpcoming = state.phase === 'UPCOMING';
    const targetTimestamp = isUpcoming ? state.startTimestamp : state.endTimestamp;

    // --- iOS: Dynamic Island & Live Activity (ActivityKit) ---
    if (Platform.OS === 'ios') {
      try {
        const liveProps: TimetableLiveActivityProps = {
          phase: state.phase,
          courseTitle: state.courseTitle || '강의',
          location: state.location,
          professor: state.professor,
          startTimestamp: state.startTimestamp || Date.now(),
          endTimestamp: state.endTimestamp || (Date.now() + 75 * 60 * 1000),
          durationMinutes: state.durationMinutes,
        };

        const activeInstances = TimetableLiveActivity.getInstances();
        if (activeInstances.length > 0) {
          // 이미 활성화된 Dynamic Island가 있으면 상태 업데이트
          await Promise.all(activeInstances.map((instance) => instance.update(liveProps)));
        } else {
          // 새로 Dynamic Island & Live Activity 시작
          TimetableLiveActivity.start(liveProps, 'intipmobileapp://timetable');
        }
      } catch (e) {
        console.warn('[TimetableNowBarService] iOS Dynamic Island 렌더링 실패:', e);
      }
      return;
    }

    // --- Android: Samsung Now Bar / Rich Ongoing Notification ---
    const title = state.courseTitle || '강의';
    const subtitle = isUpcoming ? '다음 수업' : '수업 중';

    const locationText = state.location ? `📍 ${state.location}` : '📍 강의실 미지정';
    const profText = state.professor ? ` · ${state.professor}` : '';
    const body = `${locationText}${profText}`;

    const durationMinutes =
      state.durationMinutes ||
      (state.endTimestamp && state.startTimestamp
        ? Math.max(1, Math.round((state.endTimestamp - state.startTimestamp) / (60 * 1000)))
        : 75);

    const elapsedMinutes = state.startTimestamp
      ? Math.max(0, Math.round((Date.now() - state.startTimestamp) / (60 * 1000)))
      : (state.elapsedMinutes || 0);

    try {
      await this.ensureChannel();
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
          'android.requestPromotedOngoing': 'true',
          'com.samsung.android.support.ongoing_activity': 'true',
        },
        android: {
          channelId: TIMETABLE_CHANNEL_ID,
          asForegroundService: true, // Android 16 / One UI 8 실시간 알림 섹션 고정 및 Now Bar 캡슐 승격 필수 속성
          category: isUpcoming ? AndroidCategory.EVENT : AndroidCategory.PROGRESS,
          importance: AndroidImportance.DEFAULT,
          ongoing: true, // 사용자가 스와이프로 임의 종료 불가
          autoCancel: false,
          onlyAlertOnce: true,
          visibility: AndroidVisibility.PUBLIC,
          style: {
            type: AndroidStyle.BIGTEXT,
            text: body,
          },
          showChronometer: !!targetTimestamp,
          chronometerDirection: 'down',
          timestamp: targetTimestamp,
          progress: !isUpcoming && durationMinutes
            ? {
                max: Math.max(1, durationMinutes),
                current: Math.min(durationMinutes, elapsedMinutes),
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
   * Ongoing 알림 취소 및 제거 (iOS Dynamic Island 종료 & Android Foreground Service 종료 포함)
   */
  async cancel(): Promise<void> {
    try {
      if (Platform.OS === 'ios') {
        const activeInstances = TimetableLiveActivity.getInstances();
        await Promise.all(
          activeInstances.map((instance) =>
            instance.end('immediate').catch(() => {})
          )
        );
        return;
      }

      if (Platform.OS === 'android') {
        await notifee.stopForegroundService().catch(() => {});
      }
      await notifee.cancelNotification(TIMETABLE_ONGOING_NOTIFICATION_ID);
    } catch (e) {
      console.warn('[TimetableNowBarService] 알림 취소 실패:', e);
    }
  },
};


