import { Platform } from 'react-native';
import notifee, {
  AndroidCategory,
  AndroidImportance,
  AndroidStyle,
  AndroidVisibility,
} from '@notifee/react-native';
import { TimetableActivityState } from './types';
import { TimetableStorage } from './timetableStorage';
import { TimetableLiveActivity, TimetableLiveActivityProps } from '../widgets/TimetableLiveActivity';
import { IntipAndroidLiveUpdate } from '../../modules/intip-android-live-update';

export const TIMETABLE_CHANNEL_ID = 'timetable_nowbar_v2';
export const TIMETABLE_ONGOING_NOTIFICATION_ID = 'timetable_ongoing_activity';
export const TIMETABLE_NOTIFICATION_INT_ID = 1001;

// 마지막으로 Live Activity에 반영한 props. AppState 전환마다 syncSchedule이 돌기 때문에
// 같은 내용이면 업데이트를 건너뛴다 (HIG: 새 내용이 있을 때만 업데이트).
let lastLiveActivityPropsJson: string | null = null;

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
  async renderActivity(
    state: TimetableActivityState,
    options: {
      /**
       * iOS: 실행 중인 Live Activity가 없을 때 UPCOMING을 새로 시작할지. 서버가 push-to-start로
       * 곧 시작해 줄 기기에서는 false로 넘겨 두 개가 겹치지 않게 한다 (TimetableScheduler 참고).
       */
      startUpcoming?: boolean;
      /**
       * iOS: 서버가 Live Activity의 갱신·종료를 맡는 기기(push-to-start 등록됨)에서 true. 떠 있는
       * Activity는 건드리지 않는다 — 다음 수업 것을 현재 수업으로 덮어쓰거나 끝내 버리지 않도록.
       */
      leaveExisting?: boolean;
    } = {},
  ): Promise<void> {
    const { startUpcoming = true, leaveExisting = false } = options;
    if (state.phase === 'NONE') {
      await this.cancel();
      return;
    }

    const isUpcoming = state.phase === 'UPCOMING';
    const targetTimestamp = isUpcoming ? state.startTimestamp : state.endTimestamp;

    // --- iOS: Dynamic Island & Live Activity (ActivityKit) ---
    if (Platform.OS === 'ios') {
      try {
        const startTimestamp = state.startTimestamp || Date.now();
        const { leadTimeMinutes } = await TimetableStorage.getSettings();
        const liveProps: TimetableLiveActivityProps = {
          phase: state.phase,
          courseTitle: state.courseTitle || '강의',
          location: state.location,
          professor: state.professor,
          startTimestamp,
          endTimestamp: state.endTimestamp || (startTimestamp + 75 * 60 * 1000),
          countdownFromTimestamp: startTimestamp - leadTimeMinutes * 60 * 1000,
          durationMinutes: state.durationMinutes,
        };
        const propsJson = JSON.stringify(liveProps);

        const instances = TimetableLiveActivity.getInstances();
        if (leaveExisting && instances.length > 0) return;
        const [activeInstance, ...duplicates] = instances;
        // 앱이 시작한 것과 서버 push-to-start가 시작한 것이 겹쳤으면 하나만 남긴다.
        await Promise.all(duplicates.map((instance) => instance.end('immediate').catch(() => {})));
        if (activeInstance) {
          if (propsJson === lastLiveActivityPropsJson && duplicates.length === 0) return;
          // 이미 활성화된 Dynamic Island가 있으면 상태 업데이트 (서버가 시작한 것도 여기서 이어받는다)
          await activeInstance.update(liveProps);
        } else if (state.phase === 'UPCOMING' && !startUpcoming) {
          return;
        } else {
          // 새로 Dynamic Island & Live Activity 시작
          TimetableLiveActivity.start(liveProps, 'intipmobileapp://timetable');
        }
        lastLiveActivityPropsJson = propsJson;
      } catch (e) {
        console.warn('[TimetableNowBarService] iOS Dynamic Island 렌더링 실패:', e);
      }
      return;
    }

    // --- Android: Samsung Now Bar / Rich Ongoing Notification ---
    const title = state.courseTitle || '강의';
    const subtitle = isUpcoming ? '다음 수업' : '수업 중';

    const locationText = state.location || '강의실 미지정';
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

    // --- Android 16 (One UI 8+): Samsung Now Bar / Live Update Notification ---
    if (Platform.OS === 'android' && IntipAndroidLiveUpdate.isSupported()) {
      try {
        const leadMinutes = 15;
        const progressPercent = isUpcoming
          ? 0
          : Math.min(100, Math.max(0, Math.round((elapsedMinutes / durationMinutes) * 100)));
        const shortCriticalText = isUpcoming ? '곧 시작' : '수업 중';

        IntipAndroidLiveUpdate.startOrUpdateLiveUpdate({
          id: TIMETABLE_NOTIFICATION_INT_ID,
          channelId: TIMETABLE_CHANNEL_ID,
          channelName: '실시간 시간표 (나우 바)',
          title,
          text: body,
          shortCriticalText,
          progress: progressPercent,
          segments: [
            { length: leadMinutes, color: '#5B8DEF' },
            { length: durationMinutes, color: '#043799' },
          ],
          targetTimestamp: targetTimestamp || undefined,
          ongoing: true,
        });
        return;
      } catch (e) {
        console.warn('[TimetableNowBarService] Android LiveUpdate 실패, Notifee로 폴백:', e);
      }
    }

    // --- Android 15 이하: 기존 Notifee Rich Ongoing Notification Fallback ---
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
        },
        android: {
          channelId: TIMETABLE_CHANNEL_ID,
          asForegroundService: true,
          category: isUpcoming ? AndroidCategory.EVENT : AndroidCategory.PROGRESS,
          importance: AndroidImportance.DEFAULT,
          ongoing: true,
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
   * Ongoing 알림 취소 및 제거 (iOS Dynamic Island 종료 & Android LiveUpdate/Notifee 종료 포함)
   */
  async cancel(): Promise<void> {
    try {
      if (Platform.OS === 'ios') {
        lastLiveActivityPropsJson = null;
        const activeInstances = TimetableLiveActivity.getInstances();
        await Promise.all(
          activeInstances.map((instance) =>
            instance.end('immediate').catch(() => {})
          )
        );
        return;
      }

      if (Platform.OS === 'android') {
        IntipAndroidLiveUpdate.stopLiveUpdate(TIMETABLE_NOTIFICATION_INT_ID);
        await notifee.stopForegroundService().catch(() => {});
      }
      await notifee.cancelNotification(TIMETABLE_ONGOING_NOTIFICATION_ID);
    } catch (e) {
      console.warn('[TimetableNowBarService] 알림 취소 실패:', e);
    }
  },
};


