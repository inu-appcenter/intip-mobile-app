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

export const TIMETABLE_CHANNEL_ID = 'live_update_nowbar';
export const TIMETABLE_ONGOING_NOTIFICATION_ID = 'timetable_ongoing_activity';
export const TIMETABLE_NOTIFICATION_INT_ID = 1001;

// 마지막으로 Live Activity에 반영한 props. AppState 전환마다 syncSchedule이 돌기 때문에
// 같은 내용이면 업데이트를 건너뛴다 (HIG: 새 내용이 있을 때만 업데이트).
let lastLiveActivityPropsJson: string | null = null;

type CancelListener = () => void;
const cancelListeners: Set<CancelListener> = new Set();

function formatTimeRange(startTimestamp?: number, endTimestamp?: number): string {
  if (!startTimestamp || !endTimestamp) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const startD = new Date(startTimestamp);
  const endD = new Date(endTimestamp);
  return `${pad(startD.getHours())}:${pad(startD.getMinutes())} ~ ${pad(endD.getHours())}:${pad(endD.getMinutes())}`;
}

export const TimetableNowBarService = {
  /**
   * 알림 취소 이벤트 리스너 등록
   */
  onCancel(listener: CancelListener): () => void {
    cancelListeners.add(listener);
    return () => {
      cancelListeners.delete(listener);
    };
  },
  /**
   * 알림 채널 생성 (휴대폰 소리/진동/무음 모드에 맞추어 최초 1회 알림 후, 갱신 시에는 무음 유지)
   */
  async ensureChannel(): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
      // 구 채널 정리
      await notifee.deleteChannel('timetable_nowbar').catch(() => {});
      await notifee.deleteChannel('timetable_nowbar_v2').catch(() => {});
      await notifee.deleteChannel('timetable_nowbar_v3').catch(() => {});

      await notifee.createChannel({
        id: TIMETABLE_CHANNEL_ID,
        name: '실시간 알림 (나우 바)',
        description: '실시간 현황 및 진행 상황 (시간표, 타이머 등)',
        importance: AndroidImportance.DEFAULT, // DEFAULT 중요도여야 잠금화면 실시간 카드 및 상단 상태표시줄 칩으로 승격됨
        visibility: AndroidVisibility.PUBLIC, // 잠금화면 및 AOD에 내용 전체 표시
        vibration: true,
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
    const settings = await TimetableStorage.getSettings().catch(() => ({ leadTimeMinutes: 15 }));
    const leadTimeMinutes = settings?.leadTimeMinutes || 15;

    // --- iOS: Dynamic Island & Live Activity (ActivityKit) ---
    if (Platform.OS === 'ios') {
      try {
        const startTimestamp = state.startTimestamp || Date.now();
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
    const courseTitle = state.courseTitle || '강의';
    const locationText = state.location || '강의실 미지정';
    const profText = state.professor ? ` · ${state.professor}` : '';
    const locationAndProf = `${locationText}${profText}`;
    const timeRange = formatTimeRange(state.startTimestamp, state.endTimestamp);

    const durationMinutes =
      state.durationMinutes ||
      (state.endTimestamp && state.startTimestamp
        ? Math.max(1, Math.round((state.endTimestamp - state.startTimestamp) / (60 * 1000)))
        : 75);

    const elapsedMinutes = state.startTimestamp
      ? Math.max(0, Math.round((Date.now() - state.startTimestamp) / (60 * 1000)))
      : (state.elapsedMinutes || 0);

    // 수업 전 진행률 및 남은 시간(분) 계산 (수업 전 대기 시간 100% 기준)
    const totalLeadMinutes = Math.max(leadTimeMinutes, 1);
    let upcomingProgress = 0;
    let upcomingRemainingMinutes = totalLeadMinutes;
    if (isUpcoming) {
      if (state.elapsedMinutes !== undefined && state.elapsedMinutes > 0) {
        upcomingProgress = Math.min(100, Math.max(0, Math.round((state.elapsedMinutes / totalLeadMinutes) * 100)));
        upcomingRemainingMinutes = Math.max(0, totalLeadMinutes - state.elapsedMinutes);
      } else if (state.startTimestamp) {
        const remainingMs = Math.max(0, state.startTimestamp - Date.now());
        const totalLeadMs = Math.max(totalLeadMinutes * 60 * 1000, remainingMs);
        const elapsedLeadMs = Math.max(0, totalLeadMs - remainingMs);
        upcomingProgress = Math.min(100, Math.max(0, Math.round((elapsedLeadMs / totalLeadMs) * 100)));
        upcomingRemainingMinutes = Math.ceil(remainingMs / (60 * 1000));
      }
    }

    const remainingUpcomingMs = state.startTimestamp ? Math.max(0, state.startTimestamp - Date.now()) : 0;
    const upcomingRemainingText =
      upcomingRemainingMinutes <= 0 || (remainingUpcomingMs > 0 && remainingUpcomingMs <= 30 * 1000)
        ? '곧 시작'
        : `${upcomingRemainingMinutes}분 전`;

    // 수업 중 남은 시간(분) 계산
    let classRemainingMinutes = Math.max(0, durationMinutes - elapsedMinutes);
    if (state.endTimestamp) {
      const remainingEndMs = Math.max(0, state.endTimestamp - Date.now());
      classRemainingMinutes = Math.max(0, Math.ceil(remainingEndMs / (60 * 1000)));
    }
    const ongoingRemainingText =
      classRemainingMinutes <= 0 ? '곧 종료' : `${classRemainingMinutes}분 남음`;

    // 현재 상태에 맞는 남은 시간 텍스트 (수업 전: 시작까지 N분 남음, 수업 중: 종료까지 N분 남음)
    const currentRemainingText = isUpcoming ? upcomingRemainingText : ongoingRemainingText;

    // [카드 본문]:
    // 안드로이드 ProgressStyle 알림 카드는 contentText를 최대 2줄만 노출합니다.
    // 3줄을 넘길 경우 마지막 3번째 줄(시간대)이 잘리고 2번째 줄 끝에 '...' 말줄임표가 붙으므로,
    // 1줄: 시간 정보(남은 시간 · 수업 시간대), 2줄: 장소/교수명(강의실 · 교수명) 2줄 완결형으로 구성합니다.
    const timeText = timeRange ? ` · ${timeRange}` : '';
    const line1 = `${currentRemainingText}${timeText}`;
    const line2 = locationAndProf;
    const cardBody = `${line1}\n${line2}`;

    // --- Android 16 (One UI 8+): Samsung Now Bar / Live Update Notification ---
    if (Platform.OS === 'android' && IntipAndroidLiveUpdate.isSupported()) {
      try {
        const computedEndTimestamp =
          state.endTimestamp ||
          (state.startTimestamp ? state.startTimestamp + durationMinutes * 60 * 1000 : Date.now() + durationMinutes * 60 * 1000);

        if (isUpcoming) {
          // [수업 전]: 잠금화면 하단 접힌 나우바 캡슐 및 펼친 카드 본문에 실시간 남은 시간(예: "14분 전") 표시
          IntipAndroidLiveUpdate.startOrUpdateLiveUpdate({
            id: TIMETABLE_NOTIFICATION_INT_ID,
            channelId: TIMETABLE_CHANNEL_ID,
            channelName: '실시간 알림 (나우 바)',
            title: `[다음 수업] ${courseTitle}`,
            courseTitle,
            details: cardBody,
            timeRange: timeRange || undefined,
            locationAndProf: locationAndProf || undefined,
            phase: 'UPCOMING',
            startTimestamp: state.startTimestamp || undefined,
            endTimestamp: computedEndTimestamp,
            targetTimestamp: state.startTimestamp || targetTimestamp || undefined,
            leadTimeMinutes: totalLeadMinutes,
            durationMinutes,
            text: cardBody,
            shortCriticalText: upcomingRemainingText,
            showChronometer: false,
            showWhen: false,
            progress: upcomingProgress,
            // 수업 전 대기 구간 전용 100% 단일 세그먼트 (끊김 없는 매끄러운 바)
            segments: [{ length: 100, color: '#5B8DEF' }],
            ongoing: true,
          });
          return;
        }

        // [수업 중]: 잠금화면 나우바 및 펼친 카드 본문에 수업 종료까지 남은 시간(예: "45분 남음") 표시
        const progressPercent = Math.min(
          100,
          Math.max(0, Math.round((elapsedMinutes / durationMinutes) * 100))
        );

        IntipAndroidLiveUpdate.startOrUpdateLiveUpdate({
          id: TIMETABLE_NOTIFICATION_INT_ID,
          channelId: TIMETABLE_CHANNEL_ID,
          channelName: '실시간 알림 (나우 바)',
          title: `[수업 중] ${courseTitle}`,
          courseTitle,
          details: cardBody,
          timeRange: timeRange || undefined,
          locationAndProf: locationAndProf || undefined,
          phase: 'ONGOING',
          startTimestamp: state.startTimestamp || undefined,
          endTimestamp: computedEndTimestamp,
          targetTimestamp: computedEndTimestamp,
          leadTimeMinutes: totalLeadMinutes,
          durationMinutes,
          text: cardBody,
          shortCriticalText: ongoingRemainingText,
          progress: progressPercent,
          // 오직 이 수업만을 나타내는 100% 단일 진행 바 (0% ~ 100% 매끄럽게 차오름)
          segments: [{ length: 100, color: '#043799' }],
          showChronometer: false,
          showWhen: false,
          ongoing: true,
        });
        return;
      } catch (e) {
        console.warn('[TimetableNowBarService] Android LiveUpdate 실패, Notifee로 폴백:', e);
      }
    }

    // --- Android 15 이하: 기존 Notifee Rich Ongoing Notification Fallback ---
    try {
      let classRemainingMinutes = Math.max(0, durationMinutes - elapsedMinutes);
      if (state.endTimestamp) {
        const remainingEndMs = Math.max(0, state.endTimestamp - Date.now());
        classRemainingMinutes = Math.max(0, Math.ceil(remainingEndMs / (60 * 1000)));
      }
      const ongoingRemainingText =
        classRemainingMinutes <= 0 ? '곧 종료' : `${classRemainingMinutes}분 남음`;

      await this.ensureChannel();
      await notifee.displayNotification({
        id: TIMETABLE_ONGOING_NOTIFICATION_ID,
        title: isUpcoming ? courseTitle : `[수업 중] ${courseTitle}`,
        subtitle: isUpcoming ? upcomingRemainingText : ongoingRemainingText,
        body: cardBody,
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
            text: cardBody,
          },
          showChronometer: !!targetTimestamp,
          chronometerDirection: 'down',
          timestamp: targetTimestamp,
          progress: isUpcoming
            ? {
                max: 100,
                current: upcomingProgress,
                indeterminate: false,
              }
            : durationMinutes
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
    cancelListeners.forEach((listener) => {
      try {
        listener();
      } catch (e) {
        console.warn('[TimetableNowBarService] onCancel listener error:', e);
      }
    });

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


