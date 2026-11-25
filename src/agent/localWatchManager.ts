import notifee, {
  AndroidImportance,
  TriggerType,
  TimestampTrigger,
} from '@notifee/react-native';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';
import { executeAgentAction } from './agentActionExecutor';
import { LibraryAgentTools } from './libraryTools';
import { LibraryOngoingService } from '../library/libraryOngoingService';
import { BackgroundKeepAlive, KeepAliveMode } from '../library/backgroundKeepAlive';

const STORAGE_KEY_LOCAL_WATCH = 'intip_local_watch_jobs';
const LOCAL_WATCH_CHANNEL_ID = 'local_watch_channel';

/** 감시 주기. 시험기간 경쟁을 감안해 30초(도서관 서버 부하를 생각해 그 이하로는 내리지 않는다). */
const POLL_INTERVAL_MS = 30 * 1000;
/** 인증 오류가 이 횟수 연속되면 사용자에게 알리고 해당 감시를 멈춘다. */
const MAX_CONSECUTIVE_AUTH_ERRORS = 3;

export type LocalWatchType =
  | 'STUDY_ROOM_SNIPER'
  | 'SPECIFIC_SEAT_SNIPER'
  | 'ROOM_ANY_SEAT'
  | 'SEAT_EXPIRATION'
  | 'ASSIGNMENT_REMINDER';

/** 주기적으로 조회해야 하는(=백그라운드 생존이 필요한) 감시 유형 */
export const POLLING_WATCH_TYPES: ReadonlySet<LocalWatchType> = new Set<LocalWatchType>([
  'STUDY_ROOM_SNIPER',
  'SPECIFIC_SEAT_SNIPER',
  'ROOM_ANY_SEAT',
]);

export interface LocalWatchJob {
  id: string;
  type: LocalWatchType;
  title: string;
  targetName: string;
  targetId?: string | number;
  roomId?: number;
  roomName?: string;
  seatId?: number;
  seatNo?: string;
  hopeDate?: string; // YYYY-MM-DD
  targetHour?: number; // e.g. 15 (15:00)
  createdAt: number;
  expiresAt: number; // timestamp in ms
  status: 'ACTIVE' | 'NOTIFIED' | 'EXPIRED' | 'CANCELLED';
  intervalSeconds?: number;
  /** 마지막으로 서버를 조회한 시각 */
  lastCheckedAt?: number;
  checkCount?: number;
  /** 백그라운드 유지 방식(iOS 위치 권한 결과). 웹에서 안내 문구에 쓴다. */
  keepAliveMode?: KeepAliveMode;
}

type ActiveJob = LocalWatchJob & { status: 'ACTIVE' };

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let ticking: Promise<void> | null = null;
let appStateSubscribed = false;
const authErrorCounts = new Map<string, number>();

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

function kstToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function unwrapList(data: any): any[] {
  return data?.list || data?.data?.list || (Array.isArray(data) ? data : []);
}

function isAuthError(errorCode?: string): boolean {
  return errorCode === 'AUTH_REQUIRED' || errorCode === 'HTTP_401' || errorCode === 'UNAUTHORIZED_TARGET';
}

/** 좌석 하나가 지금 바로 배정 가능한 빈자리인지 */
export function isSeatFree(seat: any): boolean {
  if (!seat) return false;
  if (seat.isActive === false) return false;
  const occupied = Boolean(seat.isOccupied) || seat.seatChargeState === 'CHARGE';
  return !occupied;
}

/** seat-rooms 공개 API 항목에서 잔여석 수 */
export function availableSeatCount(room: any): number {
  if (!room) return 0;
  const v = room.seats?.available ?? room.availableSeats;
  if (typeof v === 'number') return v;
  const total = room.seats?.total ?? room.totalSeats;
  const occ = room.seats?.occupied ?? room.occupiedSeats;
  return typeof total === 'number' && typeof occ === 'number' ? Math.max(0, total - occ) : 0;
}

type CheckResult =
  | { kind: 'FOUND'; title: string; body: string; path: string }
  | { kind: 'NOT_YET' }
  | { kind: 'ERROR'; errorCode?: string };

/** 한 tick 안에서 같은 열람실을 여러 감시가 보면 한 번만 조회한다. */
class TickCache {
  private roomSeats = new Map<number, Promise<{ ok: boolean; list: any[]; errorCode?: string }>>();
  private publicRooms: Promise<{ ok: boolean; list: any[] }> | null = null;

  seats(roomId: number) {
    let p = this.roomSeats.get(roomId);
    if (!p) {
      p = executeAgentAction(LibraryAgentTools.getRoomSeats(roomId)).then((res) => ({
        ok: res.success,
        list: unwrapList(res.data),
        errorCode: res.errorCode,
      }));
      this.roomSeats.set(roomId, p);
    }
    return p;
  }

  rooms() {
    if (!this.publicRooms) {
      this.publicRooms = executeAgentAction(LibraryAgentTools.getReadingRooms()).then((res) => ({
        ok: res.success,
        list: unwrapList(res.data),
      }));
    }
    return this.publicRooms;
  }
}

async function checkJob(job: LocalWatchJob, cache: TickCache): Promise<CheckResult> {
  if (job.type === 'ROOM_ANY_SEAT') {
    const roomId = Number(job.roomId || job.targetId);
    const res = await cache.rooms();
    if (!res.ok) return { kind: 'ERROR' };
    const room = res.list.find((r: any) => Number(r.id) === roomId);
    const available = availableSeatCount(room);
    if (available > 0) {
      return {
        kind: 'FOUND',
        title: '🎉 열람실 빈자리 발생!',
        body: `[${job.targetName}] 지금 ${available}석이 비어 있어요. 서둘러 배정하세요.`,
        path: `/services/library?tab=seats&roomId=${roomId}`,
      };
    }
    return { kind: 'NOT_YET' };
  }

  if (job.type === 'SPECIFIC_SEAT_SNIPER') {
    const roomId = Number(job.roomId);
    if (!roomId) return { kind: 'ERROR' };
    const res = await cache.seats(roomId);
    if (!res.ok) return { kind: 'ERROR', errorCode: res.errorCode };
    const target = res.list.find((s: any) => {
      if (job.seatId && Number(s.id) === Number(job.seatId)) return true;
      return job.seatNo != null && String(s.code ?? s.name ?? s.id) === String(job.seatNo);
    });
    if (target && isSeatFree(target)) {
      return {
        kind: 'FOUND',
        title: '🎉 열람실 좌석 빈자리 발생!',
        body: `기다리시던 [${job.targetName}] 좌석이 지금 비었습니다! 서둘러 배정하세요.`,
        path: `/services/library?tab=seats&roomId=${roomId}&seatId=${target.id}`,
      };
    }
    return { kind: 'NOT_YET' };
  }

  if (job.type === 'STUDY_ROOM_SNIPER') {
    const roomId = Number(job.targetId);
    const hopeDate = job.hopeDate || kstToday();
    const res = await executeAgentAction({
      actionId: `act_lib_study_room_${roomId}_${Date.now()}`,
      authDomain: 'LIBRARY',
      request: {
        method: 'GET',
        url: `https://lib.inu.ac.kr/pyxis-api/1/api/rooms/${roomId}`,
        params: { hopeDate },
      },
    });
    if (!res.success) return { kind: 'ERROR', errorCode: res.errorCode };
    const timeLine: { hour: number; minutes: { selectable?: boolean }[] }[] =
      res.data?.data?.timeLine || res.data?.timeLine || [];
    const slot = timeLine.find((t) => t.hour === job.targetHour);
    if (slot?.minutes.some((m) => m.selectable)) {
      return {
        kind: 'FOUND',
        title: '🎉 스터디룸 빈자리(취소표) 발생!',
        body: `희망하신 ${job.targetName} 취소표가 생겼습니다! 지금 바로 예약하세요.`,
        path: `/services/library?tab=study&roomId=${roomId}&date=${hopeDate}&hour=${job.targetHour}`,
      };
    }
    return { kind: 'NOT_YET' };
  }

  return { kind: 'NOT_YET' };
}

export const LocalWatchManager = {
  /**
   * 로컬 저장소에서 모든 작업 불러오기 (만료 작업은 자동 EXPIRED 전이)
   */
  async getJobs(): Promise<LocalWatchJob[]> {
    try {
      const raw = await SecureStore.getItemAsync(STORAGE_KEY_LOCAL_WATCH);
      if (!raw) return [];
      const list: LocalWatchJob[] = JSON.parse(raw);
      const now = Date.now();
      let changed = false;
      list.forEach((job) => {
        if (job.status === 'ACTIVE' && job.expiresAt <= now) {
          job.status = 'EXPIRED';
          changed = true;
        }
      });
      if (changed) await this.saveJobs(list);
      return list;
    } catch {
      return [];
    }
  },

  async saveJobs(jobs: LocalWatchJob[]): Promise<void> {
    try {
      // SecureStore 값 크기 제한(약 2KB 권장)을 넘지 않도록 끝난 작업은 최근 20개만 남긴다.
      const active = jobs.filter((j) => j.status === 'ACTIVE');
      const done = jobs.filter((j) => j.status !== 'ACTIVE').slice(0, 20);
      await SecureStore.setItemAsync(STORAGE_KEY_LOCAL_WATCH, JSON.stringify([...active, ...done]));
    } catch (e) {
      console.error('[LocalWatch] Failed to save jobs', e);
    }
  },

  async updateJob(id: string, patch: Partial<LocalWatchJob>): Promise<void> {
    const jobs = await this.getJobs();
    const target = jobs.find((j) => j.id === id);
    if (!target) return;
    Object.assign(target, patch);
    await this.saveJobs(jobs);
  },

  /** 같은 대상의 기존 ACTIVE 감시를 취소하고 새 작업을 저장한 뒤 스케줄러를 깨운다. */
  async addPollingJob(newJob: LocalWatchJob, isDuplicate: (j: LocalWatchJob) => boolean): Promise<LocalWatchJob> {
    await ensureLocalWatchChannel();
    const jobs = await this.getJobs();
    jobs.forEach((j) => {
      if (j.status === 'ACTIVE' && j.type === newJob.type && isDuplicate(j)) j.status = 'CANCELLED';
    });
    jobs.unshift(newJob);
    await this.saveJobs(jobs);

    // 등록 직후(=앱 포그라운드)에 백그라운드 유지를 켠다. iOS 위치 권한 팝업이 여기서 뜰 수 있다.
    const keepAliveMode = await BackgroundKeepAlive.start();
    newJob.keepAliveMode = keepAliveMode;
    await this.updateJob(newJob.id, { keepAliveMode });

    this.ensureScheduler();
    void this.tick({ force: true });
    return newJob;
  },

  /**
   * 스터디룸 취소표 감시 등록
   */
  async registerStudyRoomSniper(params: {
    roomId: number;
    roomName: string;
    hopeDate: string;
    targetHour: number;
    durationMinutes?: number;
  }): Promise<LocalWatchJob> {
    const now = Date.now();
    const duration = params.durationMinutes || 60;
    const job: LocalWatchJob = {
      id: `watch_study_${params.roomId}_${params.targetHour}_${now}`,
      type: 'STUDY_ROOM_SNIPER',
      title: `${params.roomName} ${params.targetHour}:00 취소표 감시`,
      targetName: `${params.roomName} (${params.targetHour}시)`,
      targetId: params.roomId,
      hopeDate: params.hopeDate,
      targetHour: params.targetHour,
      createdAt: now,
      expiresAt: now + duration * 60 * 1000,
      status: 'ACTIVE',
      intervalSeconds: POLL_INTERVAL_MS / 1000,
    };
    return this.addPollingJob(
      job,
      (j) => j.targetId === params.roomId && j.targetHour === params.targetHour && j.hopeDate === params.hopeDate
    );
  },

  /**
   * 열람실 특정 좌석 빈자리 감시 등록
   */
  async registerSpecificSeatSniper(params: {
    roomId: number;
    roomName: string;
    seatId?: number;
    seatNo: string;
    durationMinutes?: number;
  }): Promise<LocalWatchJob> {
    const now = Date.now();
    const duration = params.durationMinutes || 90;
    const job: LocalWatchJob = {
      id: `watch_seat_${params.roomId}_${params.seatNo}_${now}`,
      type: 'SPECIFIC_SEAT_SNIPER',
      title: `${params.roomName} ${params.seatNo}번 좌석 빈자리 감시`,
      targetName: `${params.roomName} ${params.seatNo}번`,
      targetId: params.seatId || params.seatNo,
      roomId: params.roomId,
      roomName: params.roomName,
      seatId: params.seatId,
      seatNo: params.seatNo,
      createdAt: now,
      expiresAt: now + duration * 60 * 1000,
      status: 'ACTIVE',
      intervalSeconds: POLL_INTERVAL_MS / 1000,
    };
    return this.addPollingJob(
      job,
      (j) => j.roomId === params.roomId && (j.seatNo === params.seatNo || (!!params.seatId && j.seatId === params.seatId))
    );
  },

  /**
   * 열람실 아무 자리나 하나라도 비면 알림 (공개 API라 도서관 로그인 불필요)
   */
  async registerRoomAnySeat(params: {
    roomId: number;
    roomName: string;
    durationMinutes?: number;
  }): Promise<LocalWatchJob> {
    const now = Date.now();
    const duration = params.durationMinutes || 120;
    const job: LocalWatchJob = {
      id: `watch_room_${params.roomId}_${now}`,
      type: 'ROOM_ANY_SEAT',
      title: `${params.roomName} 빈자리 감시`,
      targetName: params.roomName,
      targetId: params.roomId,
      roomId: params.roomId,
      roomName: params.roomName,
      createdAt: now,
      expiresAt: now + duration * 60 * 1000,
      status: 'ACTIVE',
      intervalSeconds: POLL_INTERVAL_MS / 1000,
    };
    return this.addPollingJob(job, (j) => j.roomId === params.roomId);
  },

  /**
   * 도서관 좌석 만료 20분 전 리마인더 등록 (One-shot 정시 알람)
   */
  async registerSeatExpirationReminder(params: {
    seatName: string;
    endTime: string; // "YYYY-MM-DD HH:mm:ss" or timestamp
  }): Promise<LocalWatchJob> {
    await ensureLocalWatchChannel();

    const endTimestamp = new Date(params.endTime).getTime();
    const alertTime = endTimestamp - 20 * 60 * 1000;
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

    if (alertTime <= now) {
      await notifee.displayNotification({
        id,
        title: '⏰ 좌석 이용 시간 만료 임박',
        body: `이용 중인 [${params.seatName}] 이용 시간이 얼마 남지 않았습니다. 지금 연장하거나 반납해 주세요.`,
        android: { channelId: LOCAL_WATCH_CHANNEL_ID, pressAction: { id: 'default' } },
      });
      await this.updateJob(id, { status: 'NOTIFIED' });
    } else {
      const trigger: TimestampTrigger = { type: TriggerType.TIMESTAMP, timestamp: alertTime };
      await notifee.createTriggerNotification(
        {
          id,
          title: '⏰ 좌석 이용 시간 만료 20분 전',
          body: `이용 중인 [${params.seatName}] 좌석이 20분 후 만료됩니다. 퇴실 전 연장 신청을 잊지 마세요!`,
          android: { channelId: LOCAL_WATCH_CHANNEL_ID, pressAction: { id: 'default' } },
        },
        trigger
      );
    }

    return newJob;
  },

  /** LMS 과제 마감 전용 알림. 좌석 만료 알림과 분리해 문구와 유형을 보존한다. */
  async registerAssignmentReminder(params: { assignmentName: string; dueTime: string }): Promise<LocalWatchJob> {
    await ensureLocalWatchChannel();
    const dueTimestamp = new Date(params.dueTime).getTime();
    const alertTime = dueTimestamp - 60 * 60 * 1000;
    const id = `assignment_${Date.now()}`;
    const job: LocalWatchJob = {
      id, type: 'ASSIGNMENT_REMINDER', title: 'LMS 과제 마감 알림', targetName: params.assignmentName,
      createdAt: Date.now(), expiresAt: dueTimestamp, status: 'ACTIVE',
    };
    const jobs = await this.getJobs(); jobs.unshift(job); await this.saveJobs(jobs);
    if (alertTime <= Date.now()) {
      await notifee.displayNotification({ id, title: '⏰ LMS 과제 마감 임박', body: `[${params.assignmentName}] 마감 시간을 확인하세요.`, android: { channelId: LOCAL_WATCH_CHANNEL_ID, pressAction: { id: 'default' } } });
      await this.updateJob(id, { status: 'NOTIFIED' });
    } else {
      await notifee.createTriggerNotification({ id, title: '⏰ LMS 과제 마감 1시간 전', body: `[${params.assignmentName}] 마감이 1시간 남았습니다.`, android: { channelId: LOCAL_WATCH_CHANNEL_ID, pressAction: { id: 'default' } } }, { type: TriggerType.TIMESTAMP, timestamp: alertTime });
    }
    return job;
  },

  /**
   * 감시 작업 취소
   */
  async cancelJob(id: string): Promise<boolean> {
    try {
      await notifee.cancelNotification(id);
    } catch {}
    const jobs = await this.getJobs();
    const target = jobs.find((j) => j.id === id);
    if (!target) return false;
    target.status = 'CANCELLED';
    await this.saveJobs(jobs);
    await this.syncRuntime();
    return true;
  },

  /** 작업 완료(알림 성공) 상태 전이 */
  async markJobNotified(id: string): Promise<void> {
    await this.updateJob(id, { status: 'NOTIFIED' });
    await this.syncRuntime();
  },

  async getActivePollingJobs(): Promise<ActiveJob[]> {
    const jobs = await this.getJobs();
    return jobs.filter((j): j is ActiveJob => j.status === 'ACTIVE' && POLLING_WATCH_TYPES.has(j.type));
  },

  ensureScheduler() {
    if (!appStateSubscribed) {
      appStateSubscribed = true;
      // 포그라운드 복귀 즉시 한 번 확인 (백그라운드에서 끊겼을 수 있음)
      AppState.addEventListener('change', (state) => {
        if (state === 'active') void this.tick();
      });
    }
    if (schedulerTimer) return;
    schedulerTimer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  },

  stopScheduler() {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  },

  /**
   * 남은 ACTIVE 폴링 작업 수에 맞춰 스케줄러·백그라운드 유지·상주 알림을 정리한다.
   * (이전엔 한 작업이 끝나면 다른 작업의 상주 알림/포그라운드 서비스까지 꺼버렸다.)
   */
  async syncRuntime(): Promise<void> {
    const active = await this.getActivePollingJobs();
    if (active.length === 0) {
      this.stopScheduler();
      await BackgroundKeepAlive.stop();
      await LibraryOngoingService.cancelWatchActivity();
      return;
    }
    this.ensureScheduler();
    try {
      await LibraryOngoingService.renderWatchActivity(active[0], active[0].checkCount, active.length);
    } catch {}
  },

  /**
   * 모든 ACTIVE 폴링 감시를 한 번 확인한다. 타이머·위치 태스크·AppState 복귀 등
   * 여러 곳에서 불리므로 동시 실행을 막고, 작업별로 주기가 안 됐으면 건너뛴다.
   */
  async tick(opts: { force?: boolean } = {}): Promise<void> {
    if (ticking) return ticking;
    ticking = (async () => {
      try {
        const now = Date.now();
        const jobs = await this.getJobs();
        const due = jobs.filter(
          (j) =>
            j.status === 'ACTIVE' &&
            POLLING_WATCH_TYPES.has(j.type) &&
            (opts.force || !j.lastCheckedAt || now - j.lastCheckedAt >= POLL_INTERVAL_MS - 2000)
        );
        if (due.length === 0) {
          await this.syncRuntime();
          return;
        }

        const cache = new TickCache();
        const results = await Promise.all(
          due.map(async (job) => {
            try {
              return { job, result: await checkJob(job, cache) };
            } catch (e) {
              console.warn(`[LocalWatch] check error ${job.id}:`, e);
              return { job, result: { kind: 'ERROR' } as CheckResult };
            }
          })
        );

        // 최신 저장본에 결과 반영 (그 사이 취소됐을 수 있으므로 다시 읽는다)
        const latest = await this.getJobs();
        for (const { job, result } of results) {
          const target = latest.find((j) => j.id === job.id);
          if (!target || target.status !== 'ACTIVE') continue;
          target.lastCheckedAt = now;
          target.checkCount = (target.checkCount || 0) + 1;

          if (result.kind === 'FOUND') {
            target.status = 'NOTIFIED';
            authErrorCounts.delete(job.id);
            await LibraryOngoingService.finishWatchActivity(target, 'FOUND', result.body).catch(() => {});
            await notifee.displayNotification({
              id: job.id,
              title: result.title,
              body: result.body,
              data: { path: result.path },
              ios: { sound: 'default' },
              android: {
                channelId: LOCAL_WATCH_CHANNEL_ID,
                pressAction: { id: 'default' },
                importance: AndroidImportance.HIGH,
              },
            });
          } else if (result.kind === 'ERROR' && isAuthError(result.errorCode)) {
            const n = (authErrorCounts.get(job.id) || 0) + 1;
            authErrorCounts.set(job.id, n);
            if (n >= MAX_CONSECUTIVE_AUTH_ERRORS) {
              target.status = 'CANCELLED';
              authErrorCounts.delete(job.id);
              await notifee.displayNotification({
                id: job.id,
                title: '⚠️ 빈자리 감시가 중단됐어요',
                body: `도서관 로그인이 풀려 [${job.targetName}] 감시를 계속할 수 없어요. 앱에서 도서관 계정을 다시 연결해 주세요.`,
                data: { path: '/services/library' },
                android: { channelId: LOCAL_WATCH_CHANNEL_ID, pressAction: { id: 'default' } },
              });
            }
          } else if (result.kind === 'NOT_YET') {
            authErrorCounts.delete(job.id);
          }
        }
        await this.saveJobs(latest);
        await this.syncRuntime();
      } catch (e) {
        console.warn('[LocalWatch] tick failed:', e);
      } finally {
        ticking = null;
      }
    })();
    return ticking;
  },

  /**
   * 앱 시작 시 기존 ACTIVE 상태인 작업들 자동 복구
   */
  async restoreActiveJobs() {
    const active = await this.getActivePollingJobs();
    if (active.length === 0) {
      await this.syncRuntime();
      return;
    }
    if (AppState.currentState === 'active') {
      // 권한 팝업은 이미 등록 시 처리됐으므로 여기선 조용히 재시작만 된다.
      await BackgroundKeepAlive.start();
    }
    this.ensureScheduler();
    await this.tick({ force: true });
  },
};
