import notifee, {
  AndroidImportance,
  EventType,
  TriggerType,
  TimestampTrigger,
} from '@notifee/react-native';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { executeAgentAction } from './agentActionExecutor';
import { LibraryAgentTools } from './libraryTools';

const STORAGE_KEY_LOCAL_WATCH = 'intip_local_watch_jobs';
const LOCAL_WATCH_CHANNEL_ID = 'local_watch_channel';

export type LocalWatchType = 'STUDY_ROOM_SNIPER' | 'SEAT_EXPIRATION' | 'ASSIGNMENT_REMINDER';

export interface LocalWatchJob {
  id: string;
  type: LocalWatchType;
  title: string;
  targetName: string;
  targetId?: string | number;
  hopeDate?: string; // YYYY-MM-DD
  targetHour?: number; // e.g. 15 (15:00)
  createdAt: number;
  expiresAt: number; // timestamp in ms
  status: 'ACTIVE' | 'NOTIFIED' | 'EXPIRED' | 'CANCELLED';
  intervalSeconds?: number;
}

// Active in-memory intervals for active pollers (Study room sniper)
const activePollers: Map<string, ReturnType<typeof setInterval>> = new Map();

async function ensureLocalWatchChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await notifee.createChannel({
    id: LOCAL_WATCH_CHANNEL_ID,
    name: '스마트 감시 & 리마인더',
    importance: AndroidImportance.HIGH,
    sound: 'default',
    vibration: true,
  });
}

export const LocalWatchManager = {
  /**
   * 로컬 저장소에서 모든 작업 불러오기
   */
  async getJobs(): Promise<LocalWatchJob[]> {
    try {
      const raw = await SecureStore.getItemAsync(STORAGE_KEY_LOCAL_WATCH);
      if (!raw) return [];
      const list: LocalWatchJob[] = JSON.parse(raw);
      const now = Date.now();
      let changed = false;

      // 만료된 작업 자동 상태 전이
      list.forEach((job) => {
        if (job.status === 'ACTIVE' && job.expiresAt <= now) {
          job.status = 'EXPIRED';
          changed = true;
          this.stopPoller(job.id);
        }
      });

      if (changed) {
        await this.saveJobs(list);
      }
      return list;
    } catch {
      return [];
    }
  },

  async saveJobs(jobs: LocalWatchJob[]): Promise<void> {
    try {
      await SecureStore.setItemAsync(STORAGE_KEY_LOCAL_WATCH, JSON.stringify(jobs));
    } catch (e) {
      console.error('[LocalWatch] Failed to save jobs', e);
    }
  },

  /**
   * 스터디룸 취소표 스나이퍼 등록
   * @param roomId 스터디룸 ID (예: 9)
   * @param roomName 스터디룸 이름 (예: "205호")
   * @param hopeDate 희망 날짜 ("YYYY-MM-DD")
   * @param targetHour 희망 시간 (9~21)
   * @param durationMinutes 최대 감시 시간(분) - 기본 60분
   */
  async registerStudyRoomSniper(params: {
    roomId: number;
    roomName: string;
    hopeDate: string;
    targetHour: number;
    durationMinutes?: number;
  }): Promise<LocalWatchJob> {
    await ensureLocalWatchChannel();

    const duration = params.durationMinutes || 60;
    const now = Date.now();
    const expiresAt = now + duration * 60 * 1000;
    const id = `watch_study_${params.roomId}_${params.targetHour}_${now}`;

    const newJob: LocalWatchJob = {
      id,
      type: 'STUDY_ROOM_SNIPER',
      title: `${params.roomName} ${params.targetHour}:00 취소표 감시`,
      targetName: `${params.roomName} (${params.targetHour}시)`,
      targetId: params.roomId,
      hopeDate: params.hopeDate,
      targetHour: params.targetHour,
      createdAt: now,
      expiresAt,
      status: 'ACTIVE',
      intervalSeconds: 60,
    };

    const jobs = await this.getJobs();
    // 동일 룸/시간대 활성 작업이 있다면 이전 것은 취소 처리
    jobs.forEach((j) => {
      if (
        j.status === 'ACTIVE' &&
        j.type === 'STUDY_ROOM_SNIPER' &&
        j.targetId === params.roomId &&
        j.targetHour === params.targetHour &&
        j.hopeDate === params.hopeDate
      ) {
        j.status = 'CANCELLED';
        this.stopPoller(j.id);
      }
    });

    jobs.unshift(newJob);
    await this.saveJobs(jobs);

    // 감시 폴러 즉시 시작
    this.startStudyRoomPoller(newJob);

    // 알림바에 상주 포그라운드성 알림 등록
    try {
      await notifee.displayNotification({
        id,
        title: '🎯 스터디룸 취소표 감시 시작',
        body: `${params.roomName} ${params.targetHour}:00 취소표가 나오면 즉시 알려드릴게요. (최대 ${duration}분)`,
        android: {
          channelId: LOCAL_WATCH_CHANNEL_ID,
          pressAction: { id: 'default' },
          ongoing: false,
        },
      });
    } catch {}

    return newJob;
  },

  /**
   * 도서관 좌석 만료 20분 전 리마인더 등록
   * (One-shot 정시 알람)
   */
  async registerSeatExpirationReminder(params: {
    seatName: string;
    endTime: string; // "YYYY-MM-DD HH:mm:ss" or timestamp
  }): Promise<LocalWatchJob> {
    await ensureLocalWatchChannel();

    const endTimestamp = new Date(params.endTime).getTime();
    const alertTime = endTimestamp - 20 * 60 * 1000; // 20분 전
    const now = Date.now();

    const id = `watch_seat_exp_${now}`;
    const newJob: LocalWatchJob = {
      id,
      type: 'SEAT_EXPIRATION',
      title: `${params.seatName} 좌석 반납/연장 20분 전 알림`,
      targetName: params.seatName,
      createdAt: now,
      expiresAt: endTimestamp,
      status: 'ACTIVE',
    };

    const jobs = await this.getJobs();
    jobs.unshift(newJob);
    await this.saveJobs(jobs);

    // 만료 20분 전 알람 트리거 생성 (이미 20분 미만으로 남았으면 즉시 알림)
    if (alertTime <= now) {
      await notifee.displayNotification({
        id,
        title: '⏰ 좌석 이용 시간 만료 임박',
        body: `이용 중인 [${params.seatName}] 이용 시간이 얼마 남지 않았습니다. 지금 연장하거나 반납해 주세요.`,
        android: {
          channelId: LOCAL_WATCH_CHANNEL_ID,
          pressAction: { id: 'default' },
        },
      });
      await this.markJobNotified(id);
    } else {
      const trigger: TimestampTrigger = {
        type: TriggerType.TIMESTAMP,
        timestamp: alertTime,
      };

      await notifee.createTriggerNotification(
        {
          id,
          title: '⏰ 좌석 이용 시간 만료 20분 전',
          body: `이용 중인 [${params.seatName}] 좌석이 20분 후 만료됩니다. 퇴실 전 연장 신청을 잊지 마세요!`,
          android: {
            channelId: LOCAL_WATCH_CHANNEL_ID,
            pressAction: { id: 'default' },
          },
        },
        trigger
      );
    }

    return newJob;
  },

  /**
   * 감시 작업 취소
   */
  async cancelJob(id: string): Promise<boolean> {
    this.stopPoller(id);
    try {
      await notifee.cancelNotification(id);
    } catch {}

    const jobs = await this.getJobs();
    const target = jobs.find((j) => j.id === id);
    if (!target) return false;

    target.status = 'CANCELLED';
    await this.saveJobs(jobs);
    return true;
  },

  /**
   * 작업 완료(알림 성공) 상태 전이
   */
  async markJobNotified(id: string): Promise<void> {
    this.stopPoller(id);
    const jobs = await this.getJobs();
    const target = jobs.find((j) => j.id === id);
    if (target) {
      target.status = 'NOTIFIED';
      await this.saveJobs(jobs);
    }
  },

  stopPoller(id: string) {
    const existing = activePollers.get(id);
    if (existing) {
      clearInterval(existing);
      activePollers.delete(id);
    }
  },

  /**
   * 스터디룸 취소표 주기적 폴러 실행
   */
  startStudyRoomPoller(job: LocalWatchJob) {
    this.stopPoller(job.id);

    const checkAvailability = async () => {
      const now = Date.now();
      if (job.expiresAt <= now) {
        console.log(`[LocalWatch] Job ${job.id} expired.`);
        this.stopPoller(job.id);
        const jobs = await this.getJobs();
        const target = jobs.find((j) => j.id === job.id);
        if (target && target.status === 'ACTIVE') {
          target.status = 'EXPIRED';
          await this.saveJobs(jobs);
        }
        return;
      }

      try {
        const roomId = Number(job.targetId);
        const hopeDate = job.hopeDate || new Date().toISOString().split('T')[0];
        const instruction = LibraryAgentTools.getRoomSeats(roomId);
        // hopeDate를 파라미터로 붙여 방 상세 조회
        instruction.request.url = `https://lib.inu.ac.kr/pyxis-api/1/api/rooms/${roomId}`;
        instruction.request.params = { hopeDate };

        const res = await executeAgentAction(instruction);
        if (res.success && res.data?.data?.timeLine) {
          const timeLine: Array<{
            hour: number;
            minutes: Array<{ selectable: boolean; class?: string }>;
          }> = res.data.data.timeLine;

          const targetSlot = timeLine.find((t) => t.hour === job.targetHour);
          if (targetSlot) {
            // selectable인 칸이 하나라도 있으면 빈자리 발생!
            const isAvailable = targetSlot.minutes.some((m) => m.selectable);
            if (isAvailable) {
              console.log(`[LocalWatch] 취소표 발견! Room ${roomId}, Hour ${job.targetHour}`);
              // 1. 헤드업 로컬 푸시 발송
              await notifee.displayNotification({
                id: job.id,
                title: '🎉 스터디룸 빈자리(취소표) 발생!',
                body: `희망하신 ${job.targetName} 취소표가 생겼습니다! 지금 바로 예약하세요.`,
                android: {
                  channelId: LOCAL_WATCH_CHANNEL_ID,
                  pressAction: { id: 'default' },
                  importance: AndroidImportance.HIGH,
                },
              });

              // 2. 상태 완료로 전환
              await this.markJobNotified(job.id);
            }
          }
        }
      } catch (err) {
        console.warn(`[LocalWatch] Poll check error for job ${job.id}:`, err);
      }
    };

    // 1회 즉시 실행 후 60초 간격 폴링
    checkAvailability();
    const interval = setInterval(checkAvailability, 60 * 1000);
    activePollers.set(job.id, interval);
  },

  /**
   * 앱 시작 시 기존 ACTIVE 상태인 작업들 자동 복구
   */
  async restoreActiveJobs() {
    const jobs = await this.getJobs();
    const now = Date.now();
    for (const job of jobs) {
      if (job.status === 'ACTIVE') {
        if (job.expiresAt <= now) {
          job.status = 'EXPIRED';
        } else if (job.type === 'STUDY_ROOM_SNIPER') {
          this.startStudyRoomPoller(job);
        }
      }
    }
    await this.saveJobs(jobs);
  },
};
