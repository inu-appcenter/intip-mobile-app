import { Platform } from 'react-native';
import notifee, {
  AndroidCategory,
  AndroidImportance,
  AndroidStyle,
  AndroidVisibility,
} from '@notifee/react-native';

export const LMS_DEADLINE_CHANNEL_ID = 'lms_deadline_nowbar';
export const LMS_DEADLINE_NOTIFICATION_ID = 'lms_deadline_ongoing';

export interface LmsUrgentItem {
  id: string | number;
  courseName: string;
  itemName: string;
  type: 'ASSIGNMENT' | 'QUIZ' | 'VOD';
  dueTime: number; // timestamp
  courseId?: number;
  cmid?: number;
}

export const LmsOngoingService = {
  /**
   * 알림 채널 생성
   */
  async ensureChannel(): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
      await notifee.createChannel({
        id: LMS_DEADLINE_CHANNEL_ID,
        name: 'LMS 마감 임박 알림 (나우 바/잠금화면)',
        description: '당일 마감 임박 과제 및 강의 진도 실시간 카운트다운',
        importance: AndroidImportance.DEFAULT,
        visibility: AndroidVisibility.PUBLIC,
        sound: undefined,
        vibration: false,
      });
    } catch (e) {
      console.warn('[LmsOngoingService] 채널 생성 실패:', e);
    }
  },

  /**
   * LMS 마감 임박 Ongoing 알림 렌더링
   */
  async renderUrgentDeadline(item: LmsUrgentItem): Promise<void> {
    const now = Date.now();
    if (item.dueTime <= now) {
      await this.cancel();
      return;
    }

    const remainingMs = Math.max(0, item.dueTime - now);
    const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
    const hours = Math.floor(remainingMinutes / 60);
    const mins = remainingMinutes % 60;
    const timeFormatted = hours > 0 ? `${hours}시간 ${mins}분` : `${mins}분`;

    const icon = item.type === 'ASSIGNMENT' ? '📝' : item.type === 'QUIZ' ? '📊' : '🎬';
    const typeLabel = item.type === 'ASSIGNMENT' ? '과제' : item.type === 'QUIZ' ? '퀴즈' : '동영상 강의';

    const title = `🚨 [${item.courseName}] ${icon} ${item.itemName}`;
    const subtitle = `LMS ${typeLabel} 마감 임박`;
    const body = `마감까지 남은 시간: ${timeFormatted} (마감: ${new Date(item.dueTime).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })})`;

    try {
      await this.ensureChannel();
      await notifee.displayNotification({
        id: LMS_DEADLINE_NOTIFICATION_ID,
        title,
        subtitle,
        body,
        data: {
          type: 'lms_deadline',
          courseId: String(item.courseId || ''),
          cmid: String(item.cmid || ''),
          path: '/services/lms',
          'android.requestPromotedOngoing': 'true',
          'com.samsung.android.support.ongoing_activity': 'true',
        },
        android: {
          channelId: LMS_DEADLINE_CHANNEL_ID,
          asForegroundService: true,
          category: AndroidCategory.REMINDER,
          importance: AndroidImportance.DEFAULT,
          ongoing: true,
          autoCancel: false,
          onlyAlertOnce: true,
          visibility: AndroidVisibility.PUBLIC,
          style: {
            type: AndroidStyle.BIGTEXT,
            text: `${body}\n미제출 시 감점될 수 있습니다. 지금 LMS에서 확인하세요!`,
          },
          showChronometer: true,
          chronometerDirection: 'down',
          timestamp: item.dueTime,
          progress: {
            max: 180, // 기준 3시간
            current: Math.max(0, Math.min(180, 180 - remainingMinutes)),
            indeterminate: false,
          },
          actions: [
            {
              title: 'LMS 바로가기',
              pressAction: {
                id: 'lms_view',
              },
            },
            {
              title: '알림 닫기',
              pressAction: {
                id: 'cancel_lms_deadline',
              },
            },
          ],
          pressAction: {
            id: 'default',
          },
        },
      });
    } catch (e) {
      console.error('[LmsOngoingService] 마감 알림 렌더링 실패:', e);
    }
  },

  /**
   * LMS Ongoing 알림 취소
   */
  async cancel(): Promise<void> {
    try {
      if (Platform.OS === 'android') {
        await notifee.stopForegroundService().catch(() => {});
      }
      await notifee.cancelNotification(LMS_DEADLINE_NOTIFICATION_ID);
    } catch (e) {
      console.warn('[LmsOngoingService] 알림 취소 실패:', e);
    }
  },
};
