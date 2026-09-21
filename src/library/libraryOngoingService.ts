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

export const LIBRARY_WATCH_CHANNEL_ID = 'library_watch_nowbar';
export const LIBRARY_SEAT_SESSION_CHANNEL_ID = 'library_seat_session_nowbar';

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
      await notifee.createChannel({
        id: LIBRARY_WATCH_CHANNEL_ID,
        name: '도서관 빈자리 감시 (나우 바/잠금화면)',
        description: '열람실 특정 좌석 및 스터디룸 취소표 실시간 감시 상태 표시',
        importance: AndroidImportance.DEFAULT,
        visibility: AndroidVisibility.PUBLIC,
        sound: undefined,
        vibration: false,
      });

      await notifee.createChannel({
        id: LIBRARY_SEAT_SESSION_CHANNEL_ID,
        name: '도서관 좌석 이용 현황 (나우 바/잠금화면)',
        description: '현재 이용 중인 열람실 좌석 잔여 시간 및 원클릭 연장/반납',
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
  async renderWatchActivity(job: LocalWatchJob, checkCount?: number): Promise<void> {
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
    const title = isStudyRoom
      ? `🎯 [스터디룸] ${job.targetName} 취소표 감시 중`
      : `🎯 [열람실] ${job.targetName} 빈자리 감시 중`;

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
          roomId: String(job.roomId || job.targetId || ''),
          seatNo: String(job.seatNo || ''),
          path: `/services/library?roomId=${job.roomId || job.targetId || ''}`,
          'android.requestPromotedOngoing': 'true',
          'com.samsung.android.support.ongoing_activity': 'true',
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
              title: '열람실 보기',
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
   * 도서관 감시 Ongoing 알림 취소
   */
  async cancelWatchActivity(): Promise<void> {
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
          path: '/services/library?tab=seats',
          'android.requestPromotedOngoing': 'true',
          'com.samsung.android.support.ongoing_activity': 'true',
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
