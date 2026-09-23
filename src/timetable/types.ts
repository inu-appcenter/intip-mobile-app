export type TimetableDay =
  | 'MONDAY'
  | 'TUESDAY'
  | 'WEDNESDAY'
  | 'THURSDAY'
  | 'FRIDAY'
  | 'SATURDAY'
  | 'SUNDAY';

export interface TimetableMeeting {
  id?: number | null;
  day: TimetableDay;
  startTime: string; // "HH:mm" e.g. "09:00"
  endTime: string; // "HH:mm" e.g. "10:15"
  location?: string | null; // e.g. "정보기술대학 7호관 314호"
}

export interface TimetableCourseItem {
  id?: number | null;
  title: string;
  professor?: string | null;
  meetings: TimetableMeeting[];
}

export interface TimetableData {
  updatedAt: number;
  courses: TimetableCourseItem[];
}

export interface TimetableNowBarSettings {
  enabled: boolean;
  leadTimeMinutes: number; // 수업 시작 몇 분 전에 노출할지 (기본 15분)
}

export type TimetableActivityPhase = 'NONE' | 'UPCOMING' | 'ONGOING';

export interface TimetableActivityState {
  phase: TimetableActivityPhase;
  courseTitle?: string;
  location?: string;
  professor?: string;
  startTimestamp?: number; // epoch ms
  endTimestamp?: number; // epoch ms
  durationMinutes?: number;
  elapsedMinutes?: number;
}
