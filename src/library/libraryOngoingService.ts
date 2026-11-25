import { Platform } from 'react-native';
import notifee, {
  AndroidCategory,
  AndroidImportance,
  AndroidStyle,
  AndroidVisibility,
} from '@notifee/react-native';
import { executeAgentAction } from '../agent/agentActionExecutor';
import { LibraryAgentTools } from '../agent/libraryTools';
import { LocalWatchJob } from '../agent/localWatchManager';
import {
  LibraryWatchLiveActivity,
  LibraryWatchLiveActivityProps,
} from '../widgets/LibraryWatchLiveActivity';
import { after } from 'expo-widgets';

let lastWatchLiveJson: string | null = null;

function watchKind(job: LocalWatchJob): LibraryWatchLiveActivityProps['kind'] {
  if (job.type === 'STUDY_ROOM_SNIPER') return 'STUDY_ROOM';
  if (job.type === 'ROOM_ANY_SEAT') return 'ROOM';
  return 'SEAT';
}

/** 알림·Live Activity 탭 시 열 웹 경로. 웹 도서관 페이지가 roomId/seatId/date/hour를 읽어 바로 연다. */
export function watchLibraryPath(job: LocalWatchJob): string {
  if (job.type === 'STUDY_ROOM_SNIPER') {
    const date = job.hopeDate ? `&date=${job.hopeDate}` : '';
    const hour = job.targetHour != null ? `&hour=${job.targetHour}` : '';
    return `/services/library?tab=study&roomId=${job.targetId ?? ''}${date}${hour}`;
  }
  const roomId = job.roomId || job.targetId || '';
  const seat = job.type === 'SPECIFIC_SEAT_SNIPER' && job.seatId ? `&seatId=${job.seatId}` : '';
  return `/services/library?tab=seats&roomId=${roomId}${seat}`;
}

function watchDeepLink(job: LocalWatchJob): string {
  return `intipmobileapp:/${watchLibraryPath(job)}`;
}

function watchLiveProps(
  job: LocalWatchJob,
  activeCount: number,
  phase: LibraryWatchLiveActivityProps['phase'] = 'WATCHING',
  message?: string,
): LibraryWatchLiveActivityProps {
  return {
    phase,
    kind: watchKind(job),
    targetName: job.targetName,
    extraCount: Math.max(0, activeCount - 1),
    startedAt: job.createdAt,
    expiresAt: job.expiresAt,
    checkCount: job.checkCount || 0,
    lastCheckedAt: job.lastCheckedAt,
    message,
  };
}

/**
 * iOS: 감시 중 Live Activity 시작/갱신. 같은 내용이면 건너뛴다(위치 콜백이 ~5초마다 syncRuntime을
 * 부르므로). 시작은 앱이 포그라운드일 때만 가능하다(ActivityKit 제약) — 감시는 사용자가 등록 화면에서
 * 켜므로 그 시점에 시작된다. 백그라운드에서 start가 실패하면 다음 포그라운드 복귀 때 다시 시도된다.
 */
async function renderWatchLiveActivity(job: LocalWatchJob, activeCount: number): Promise<void> {
  const props = watchLiveProps(job, activeCount);
  const json = JSON.stringify(props);
  const [current, ...dupes] = LibraryWatchLiveActivity.getInstances();
  await Promise.all(dupes.map((d) => d.end('immediate').catch(() => {})));
  if (current) {
    if (json === lastWatchLiveJson && dupes.length === 0) return;
    await current.update(props, new Date(job.expiresAt));
  } else {
    LibraryWatchLiveActivity.start(props, watchDeepLink(job), new Date(job.expiresAt));
  }
  lastWatchLiveJson = json;
}

async function endWatchLiveActivities(final?: LibraryWatchLiveActivityProps, keepMinutes = 0): Promise<void> {
  lastWatchLiveJson = null;
  const instances = LibraryWatchLiveActivity.getInstances();
  await Promise.all(
    instances.map((instance) =>
      final && keepMinutes > 0
        ? instance.end(after(new Date(Date.now() + keepMinutes * 60 * 1000)), final).catch(() => {})
        : instance.end('immediate').catch(() => {}),
    ),
  );
}

export const LIVE_UPDATE_NOWBAR_CHANNEL_ID = 'live_update_nowbar';
export const LIBRARY_WATCH_CHANNEL_ID = LIVE_UPDATE_NOWBAR_CHANNEL_ID;
export const LIBRARY_SEAT_SESSION_CHANNEL_ID = LIVE_UPDATE_NOWBAR_CHANNEL_ID;

export const LIBRARY_WATCH_NOTIFICATION_ID = 'library_watch_ongoing';
export const LIBRARY_SEAT_SESSION_NOTIFICATION_ID = 'library_seat_session_ongoing';

export interface LibrarySeatSession {
  seatId?: number;
  seatNo: string;
  roomName: string;
  roomId?: number;
  startTime: number; // timestamp
  endTime: number; // timestamp
  totalMinutes?: number;
}

export const LibraryOngoingService = {
  /**
   * 알림 채널 생성 (Android 전용: 잠금화면 및 상태바에 당당히 상주하도록 DEFAULT 중요도 적용)
   */
  async ensureChannels(): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
      // 구 채널 정리
      await notifee.deleteChannel('library_watch_nowbar').catch(() => {});
      await notifee.deleteChannel('library_seat_session_nowbar').catch(() => {});

      await notifee.createChannel({
        id: LIVE_UPDATE_NOWBAR_CHANNEL_ID,
        name: '실시간 알림 (나우 바)',
        description: '실시간 현황 및 진행 상황 (시간표, 도서관, LMS 등)',
        importance: AndroidImportance.DEFAULT,
        visibility: AndroidVisibility.PUBLIC,
        sound: undefined,
        vibration: false,
      });
    } catch (e) {
      console.warn('[LibraryOngoingService] 채널 생성 실패:', e);
    }
  },

  /**
   * 1. 도서관 빈자리/취소표 감시 Ongoing Notification 렌더링
   */
  async renderWatchActivity(job: LocalWatchJob, checkCount?: number, activeCount = 1): Promise<void> {
    // 상주(ongoing) 알림·포그라운드 서비스는 Android 개념. iOS는 로컬 Live Activity로 대신한다
    // (알림으로 그리면 위치 콜백 ~5초마다 알림 요청이 새로 등록됐다 — 실기기 로그로 확인).
    if (Platform.OS === 'ios') {
      if (job.status !== 'ACTIVE') {
        await endWatchLiveActivities();
        return;
      }
      try {
        await renderWatchLiveActivity({ ...job, checkCount: checkCount ?? job.checkCount }, activeCount);
      } catch (e) {
        console.warn('[LibraryOngoingService] 감시 Live Activity 실패:', e);
      }
      return;
    }
    if (Platform.OS !== 'android') return;
    if (job.status !== 'ACTIVE') {
      await this.cancelWatchActivity();
      return;
    }

    const now = Date.now();
    const remainingMs = Math.max(0, job.expiresAt - now);
    const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
    const totalDurationMinutes = Math.round((job.expiresAt - job.createdAt) / (60 * 1000)) || 90;
    const elapsedMinutes = Math.max(0, totalDurationMinutes - remainingMinutes);

    const isStudyRoom = job.type === 'STUDY_ROOM_SNIPER';
    const targetRoomId = job.roomId || job.targetId || '';
    const libraryPath = watchLibraryPath(job);

    const extra = activeCount > 1 ? ` 외 ${activeCount - 1}건` : '';
    const title = isStudyRoom
      ? `🎯 [스터디룸] ${job.targetName}${extra} 취소표 감시 중`
      : `🎯 [열람실] ${job.targetName}${extra} 빈자리 감시 중`;

    const subtitle = '스마트 캠퍼스 감시';
    const checkText = checkCount ? ` · ${checkCount}회 확인` : '';
    const body = `남은 감시 시간: ${remainingMinutes}분 (최대 ${totalDurationMinutes}분)${checkText}`;

    try {
      await this.ensureChannels();
      await notifee.displayNotification({
        id: LIBRARY_WATCH_NOTIFICATION_ID,
        title,
        subtitle,
        body,
        data: {
          type: 'library_watch',
          watchType: job.type,
          jobId: job.id,
          roomId: String(targetRoomId),
          seatNo: String(job.seatNo || ''),
          path: libraryPath,
        },
        android: {
          channelId: LIBRARY_WATCH_CHANNEL_ID,
          asForegroundService: true,
          category: AndroidCategory.PROGRESS,
          importance: AndroidImportance.DEFAULT,
          ongoing: true,
          autoCancel: false,
          onlyAlertOnce: true,
          visibility: AndroidVisibility.PUBLIC,
          style: {
            type: AndroidStyle.BIGTEXT,
            text: `${body}\n빈자리가 발생하면 즉시 고우선순위 알림으로 알려드립니다.`,
          },
          showChronometer: true,
          chronometerDirection: 'down',
          timestamp: job.expiresAt,
          progress: {
            max: Math.max(1, totalDurationMinutes),
            current: Math.min(totalDurationMinutes, elapsedMinutes),
            indeterminate: false,
          },
          actions: [
            {
              title: isStudyRoom ? '스터디룸 보기' : '열람실 보기',
              pressAction: {
                id: 'library_view',
              },
            },
            {
              title: '감시 중단',
              pressAction: {
                id: 'cancel_library_watch',
              },
            },
          ],
          pressAction: {
            id: 'default',
          },
        },
      });
    } catch (e) {
      console.error('[LibraryOngoingService] 감시 알림 렌더링 실패:', e);
    }
  },

  /**
   * iOS: 빈자리/취소표 발견 → Live Activity를 FOUND 상태로 끝내고 잠금화면에 10분 남긴다.
   * (헤드업 알림은 LocalWatchManager가 따로 보낸다 — Live Activity 갱신은 소리·배너가 없으므로.)
   */
  async finishWatchActivity(job: LocalWatchJob, phase: 'FOUND' | 'ENDED', message: string): Promise<void> {
    if (Platform.OS !== 'ios') return;
    await endWatchLiveActivities(watchLiveProps(job, 1, phase, message), phase === 'FOUND' ? 10 : 2);
  },

  /**
   * 도서관 감시 Ongoing 알림 취소
   */
  async cancelWatchActivity(): Promise<void> {
    if (Platform.OS === 'ios') {
      await endWatchLiveActivities();
      return;
    }
    try {
      if (Platform.OS === 'android') {
        await notifee.stopForegroundService().catch(() => {});
      }
      await notifee.cancelNotification(LIBRARY_WATCH_NOTIFICATION_ID);
    } catch (e) {
      console.warn('[LibraryOngoingService] 감시 알림 취소 실패:', e);
    }
  },

  /**
   * 2. 도서관 좌석 이용 중 실시간 잔여시간 & 원클릭 연장/반납 Ongoing Bar 렌더링
   */
  async renderActiveSeatSession(session: LibrarySeatSession): Promise<void> {
    const now = Date.now();
    if (session.endTime <= now) {
      await this.cancelActiveSeatSession();
      return;
    }

    const remainingMs = Math.max(0, session.endTime - now);
    const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
    const totalMinutes =
      session.totalMinutes ||
      Math.max(1, Math.round((session.endTime - session.startTime) / (60 * 1000))) ||
      120;
    const elapsedMinutes = Math.max(0, totalMinutes - remainingMinutes);

    const title = `🪑 [${session.roomName}] ${session.seatNo}번 좌석 이용 중`;
    const subtitle = '도서관 좌석 이용';
    const hours = Math.floor(remainingMinutes / 60);
    const mins = remainingMinutes % 60;
    const timeFormatted = hours > 0 ? `${hours}시간 ${mins}분` : `${mins}분`;
    const body = `남은 이용 시간: ${timeFormatted} (만료 시각: ${new Date(session.endTime).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })})`;

    try {
      await this.ensureChannels();
      await notifee.displayNotification({
        id: LIBRARY_SEAT_SESSION_NOTIFICATION_ID,
        title,
        subtitle,
        body,
        data: {
          type: 'library_seat_session',
          seatId: String(session.seatId || ''),
          seatNo: session.seatNo,
          roomId: String(session.roomId || ''),
          roomName: session.roomName,
          path: '/services/library?tab=my',
        },
        android: {
          channelId: LIBRARY_SEAT_SESSION_CHANNEL_ID,
          asForegroundService: true,
          category: AndroidCategory.PROGRESS,
          importance: AndroidImportance.DEFAULT,
          ongoing: true,
          autoCancel: false,
          onlyAlertOnce: true,
          visibility: AndroidVisibility.PUBLIC,
          style: {
            type: AndroidStyle.BIGTEXT,
            text: `${body}\n퇴실 시 원클릭으로 반납하거나, 만료 전 연장할 수 있습니다.`,
          },
          showChronometer: true,
          chronometerDirection: 'down',
          timestamp: session.endTime,
          progress: {
            max: Math.max(1, totalMinutes),
            current: Math.min(totalMinutes, elapsedMinutes),
            indeterminate: false,
          },
          actions: [
            {
              title: '2시간 연장',
              pressAction: {
                id: 'library_extend_seat',
              },
            },
            {
              title: '퇴실 반납',
              pressAction: {
                id: 'library_return_seat',
              },
            },
          ],
          pressAction: {
            id: 'default',
          },
        },
      });
    } catch (e) {
      console.error('[LibraryOngoingService] 좌석 세션 알림 렌더링 실패:', e);
    }
  },

  /**
   * 도서관 좌석 이용 세션 알림 취소
   */
  async cancelActiveSeatSession(): Promise<void> {
    try {
      if (Platform.OS === 'android') {
        await notifee.stopForegroundService().catch(() => {});
      }
      await notifee.cancelNotification(LIBRARY_SEAT_SESSION_NOTIFICATION_ID);
    } catch (e) {
      console.warn('[LibraryOngoingService] 좌석 세션 알림 취소 실패:', e);
    }
  },

  /**
   * 원클릭 좌석 연장 실행
   */
  async handleQuickExtend(): Promise<{ success: boolean; message: string }> {
    try {
      const mySeatRes = await executeAgentAction(LibraryAgentTools.getMyCurrentSeat());
      const seatData = mySeatRes.data?.data || mySeatRes.data;
      const chargeId = seatData?.id || seatData?.chargeId;

      if (!chargeId) {
        return { success: false, message: '현재 이용 중인 좌석 정보를 찾을 수 없습니다.' };
      }

      const instruction = LibraryAgentTools.renewSeat(Number(chargeId));
      const res = await executeAgentAction(instruction);
      if (res.success) {
        // 연장 후 내 좌석 정보 다시 조회하여 알림 갱신
        const updatedSeatRes = await executeAgentAction(LibraryAgentTools.getMyCurrentSeat());
        if (updatedSeatRes.success && updatedSeatRes.data) {
          const updated = updatedSeatRes.data?.data || updatedSeatRes.data;
          if (updated?.expireTime) {
            const endTime = new Date(updated.expireTime).getTime();
            const startTime = updated.startTime ? new Date(updated.startTime).getTime() : Date.now();
            await this.renderActiveSeatSession({
              seatNo: String(updated.seat?.code || updated.seatNo || '좌석'),
              roomName: updated.room?.name || '열람실',
              roomId: updated.room?.id,
              startTime,
              endTime,
            });
          }
        }
        return { success: true, message: '좌석이 성공적으로 연장되었습니다.' };
      }
      return { success: false, message: res.errorMessage || '좌석 연장에 실패했습니다.' };
    } catch (e: any) {
      return { success: false, message: e.message || '좌석 연장 중 오류가 발생했습니다.' };
    }
  },

  /**
   * 원클릭 좌석 반납 실행
   */
  async handleQuickReturn(): Promise<{ success: boolean; message: string }> {
    try {
      const mySeatRes = await executeAgentAction(LibraryAgentTools.getMyCurrentSeat());
      const seatData = mySeatRes.data?.data || mySeatRes.data;
      const chargeId = seatData?.id || seatData?.chargeId;

      if (!chargeId) {
        await this.cancelActiveSeatSession();
        return { success: true, message: '이용 중인 좌석이 없습니다.' };
      }

      const instruction = LibraryAgentTools.returnSeat(Number(chargeId));
      const res = await executeAgentAction(instruction);
      if (res.success) {
        await this.cancelActiveSeatSession();
        // 반납 완료 팝업 알림
        await notifee.displayNotification({
          id: 'library_return_success',
          title: '✅ 도서관 좌석 반납 완료',
          body: '좌석이 정상적으로 반납되었습니다. 이용해 주셔서 감사합니다.',
          android: {
            channelId: LIBRARY_SEAT_SESSION_CHANNEL_ID,
            pressAction: { id: 'default' },
          },
        });
        return { success: true, message: '좌석이 정상적으로 반납되었습니다.' };
      }
      return { success: false, message: res.errorMessage || '좌석 반납에 실패했습니다.' };
    } catch (e: any) {
      return { success: false, message: e.message || '좌석 반납 중 오류가 발생했습니다.' };
    }
  },
};
