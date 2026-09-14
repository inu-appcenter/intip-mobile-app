/**
 * Timetable data for the three schedule widgets — 다음 수업, 오늘 수업, 시간표.
 *
 * All three read the same thing: the user's primary timetable for the current
 * semester. So it is fetched once and transformed three ways, rather than each
 * widget pulling its own copy.
 *
 * The fetch is the only part that touches the network; every transform below
 * is pure and takes `now` as an argument, which is what makes them testable
 * (see `__tests__/timetable.test.ts`) and what lets a caller precompute the
 * states a timeline will pass through later in the day without waiting for
 * those times to arrive. That matters on iOS, where a widget can be handed
 * several future-dated entries and will advance through them with no further
 * network at all — a day's classes are known in advance, so the schedule
 * widgets should never need a second fetch in a day.
 *
 * API shapes mirror inu-portal-web's `src/types/timetables.ts`. They are
 * duplicated rather than imported: the two repos share no package, and the
 * widgets need a much smaller subset than the portal's own timetable editor.
 */
import type { NextClassWidgetProps } from '../NextClassWidget';
import type { ClassBlock, TimetableWidgetProps } from '../TimetableWidget';
import type { TodayClassesWidgetProps } from '../TodayClassesWidget';
import { getJson } from './apiClient';

// --- API shapes (subset of the portal's) -----------------------------------

type Term = 'FIRST' | 'SUMMER' | 'SECOND' | 'WINTER';

type TimeTableSummary = {
  id: number;
  semesterId?: number;
  year: number;
  term: Term;
  timeTableName?: string;
  isPrimary: boolean;
};

/**
 * One semester, from `GET /api/semesters`.
 *
 * `status` is the server's own notion of which semester is live; the dates are
 * the calendar it derives that from. Both are used, in that order — see
 * `currentSemesterOf`.
 */
export type Semester = {
  id: number;
  year: number;
  term: Term;
  status: 'UPCOMING' | 'OPEN' | 'CLOSED';
  /** `YYYY-MM-DD`. */
  startDate: string;
  /** `YYYY-MM-DD`. */
  endDate: string;
};

type TimeTableDay =
  | 'MONDAY'
  | 'TUESDAY'
  | 'WEDNESDAY'
  | 'THURSDAY'
  | 'FRIDAY'
  | 'SATURDAY'
  | 'SUNDAY';

type TimeTableMeeting = {
  location: string | null;
  day: TimeTableDay;
  /** `HH:mm`. */
  startTime: string;
  /** `HH:mm`. */
  endTime: string;
};

type TimeTableDetail = {
  id: number;
  items: {
    type: 'COURSE' | 'CUSTOM';
    course: { courseOfferingId: number | null; title: string | null; meetings: TimeTableMeeting[] } | null;
    customSchedule: { customScheduleId: number | null; title: string | null; meetings: TimeTableMeeting[] } | null;
  }[];
};

// --- Normalized form the transforms work on --------------------------------

/** One meeting of one class, flattened out of the API's course/custom split. */
export type ClassMeeting = {
  /** Monday = 0 … Sunday = 6. */
  dayIndex: number;
  /** Minutes from midnight. */
  startMinutes: number;
  endMinutes: number;
  title: string;
  room: string;
  /** Stable per course, so a class keeps its color across refreshes. */
  colorKey: string;
};

/**
 * The Figma timetable palette (`timeTable-color/*`), in token order.
 *
 * The API does not return a color for a course — the portal assigns one
 * client-side — so the widgets do the same. Assignment is by a hash of the
 * course's identity rather than its position in the list, so a class keeps the
 * same color when the list changes and across refreshes; `#CED3D7` (gray) is
 * excluded, since it reads as "disabled" next to the others.
 */
export const TIMETABLE_COLORS = [
  '#FFA6A6',
  '#FFCB94',
  '#FFE589',
  '#8CE99A',
  '#79DDDF',
  '#94CDFA',
  '#ACBCFD',
  '#C1ACFC',
  '#E9ADF7',
  '#FAB5CD',
] as const;

/**
 * The hour the 시간표 widget's grid starts at. Its `startMinutes` are measured
 * from here, not from midnight — see `TimetableWidget.tsx`'s `hourGrid`, whose
 * own `START_HOUR` this has to agree with. Duplicated rather than imported
 * because that constant lives *inside* the `'widget'` function, where only
 * that function's own source ships to the widget process.
 */
export const TIMETABLE_GRID_START_HOUR = 8;

const DAY_INDEX: Record<TimeTableDay, number> = {
  MONDAY: 0,
  TUESDAY: 1,
  WEDNESDAY: 2,
  THURSDAY: 3,
  FRIDAY: 4,
  SATURDAY: 5,
  SUNDAY: 6,
};

/** `"14:30"` → 870. Returns null for anything that isn't `HH:mm`. */
export function parseHhMm(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 870 → `"14:30"`. */
export function formatHhMm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Picks the color for a class. Deterministic, and deliberately keyed on
 * something stable (the course offering id where there is one, the title
 * otherwise) rather than on list order.
 */
export function colorFor(colorKey: string): string {
  let hash = 0;
  for (let i = 0; i < colorKey.length; i += 1) {
    // Plain 32-bit string hash; `| 0` keeps it in int range on Hermes.
    hash = (hash * 31 + colorKey.charCodeAt(i)) | 0;
  }
  return TIMETABLE_COLORS[Math.abs(hash) % TIMETABLE_COLORS.length];
}

/** Flattens an API timetable into one entry per meeting, sorted by start. */
export function toClassMeetings(detail: TimeTableDetail): ClassMeeting[] {
  const meetings: ClassMeeting[] = [];

  for (const item of detail.items ?? []) {
    const source = item.type === 'COURSE' ? item.course : item.customSchedule;
    if (!source) continue;

    const title = source.title?.trim();
    if (!title) continue;

    const colorKey =
      item.type === 'COURSE' && item.course?.courseOfferingId != null
        ? `course:${item.course.courseOfferingId}`
        : `title:${title}`;

    for (const meeting of source.meetings ?? []) {
      const startMinutes = parseHhMm(meeting.startTime);
      const endMinutes = parseHhMm(meeting.endTime);
      const dayIndex = DAY_INDEX[meeting.day];
      // A meeting missing a day or with unparseable/backwards times is
      // dropped rather than clamped: a class drawn at the wrong time is worse
      // than one that isn't drawn, and this is unattended rendering.
      if (dayIndex === undefined || startMinutes === null || endMinutes === null) continue;
      if (endMinutes <= startMinutes) continue;

      meetings.push({
        dayIndex,
        startMinutes,
        endMinutes,
        title,
        room: formatRoom(meeting.location?.trim() ?? ''),
        colorKey,
      });
    }
  }

  return meetings.sort((a, b) =>
    a.dayIndex !== b.dayIndex ? a.dayIndex - b.dayIndex : a.startMinutes - b.startMinutes,
  );
}

/**
 * Shortens the portal's full room name to the building-room form students use:
 * "제7호관 정보기술대학-505 강의실(중)-2" → "7-505".
 *
 * Anything not in that shape (an already-short "07-504", a custom schedule's
 * free-text place, an empty string for an online class) comes back unchanged.
 */
export const formatRoom = (room: string) => {
  const match = room.match(/^제(.+?)호관\s+.*?-([^\s]+)/);
  return match ? `${match[1]}-${match[2]}` : room;
};

/** Monday = 0 … Sunday = 6, matching {@link ClassMeeting.dayIndex}. */
export function dayIndexOf(now: Date): number {
  return (now.getDay() + 6) % 7;
}

function minutesOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

// --- Transforms ------------------------------------------------------------

/**
 * "다음 수업" — the class happening now, or the next one today.
 *
 * Only ever reports on *today*. Once the day's last class ends the widget says
 * so rather than jumping to tomorrow's first: `doneForToday` carries that
 * label instead, which is what the Figma frame specs.
 */
export function toNextClassProps(meetings: ClassMeeting[], now: Date): NextClassWidgetProps {
  const today = meetings.filter((m) => m.dayIndex === dayIndexOf(now));
  if (today.length === 0) return { status: 'dayOff' };

  const nowMinutes = minutesOfDay(now);

  const ongoing = today.find((m) => m.startMinutes <= nowMinutes && nowMinutes < m.endMinutes);
  if (ongoing) {
    return {
      status: 'ongoing',
      className: ongoing.title,
      location: ongoing.room || '온라인 수업',
      endsAtLabel: `${formatHhMm(ongoing.endMinutes)}에 끝나요`,
    };
  }

  const upcoming = today.find((m) => m.startMinutes > nowMinutes);
  if (upcoming) {
    return {
      status: 'upcoming',
      className: upcoming.title,
      location: upcoming.room || '온라인 수업',
      timeRange: `${formatHhMm(upcoming.startMinutes)}–${formatHhMm(upcoming.endMinutes)}`,
    };
  }

  return { status: 'doneForToday', nextClassLabel: '오늘 수업이 모두 끝났어요' };
}

/** `"9월 1일 화요일"`, the header the 오늘 수업 frame specs. */
export function formatDateLabel(now: Date): string {
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][now.getDay()];
  return `${now.getMonth() + 1}월 ${now.getDate()}일 ${weekday}요일`;
}

/**
 * The 오늘 수업 header's right-hand notice — how long until the next class, or
 * that one is running. Mirrors the Figma frame's "1시간 후 시작".
 */
function noticeFor(today: ClassMeeting[], nowMinutes: number): string {
  const ongoing = today.find((m) => m.startMinutes <= nowMinutes && nowMinutes < m.endMinutes);
  if (ongoing) return '수업 중';

  const upcoming = today.find((m) => m.startMinutes > nowMinutes);
  if (!upcoming) return '오늘 수업 종료';

  const minutesUntil = upcoming.startMinutes - nowMinutes;
  if (minutesUntil < 60) return `${minutesUntil}분 후 시작`;
  return `${Math.floor(minutesUntil / 60)}시간 후 시작`;
}

/**
 * "오늘 수업" — today's remaining classes.
 *
 * Classes that have already ended are dropped rather than greyed out: the
 * widget only has room for three rows, and the ones still to come are the ones
 * worth the space.
 */
export function toTodayClassesProps(meetings: ClassMeeting[], now: Date): TodayClassesWidgetProps {
  const dateLabel = formatDateLabel(now);
  const today = meetings.filter((m) => m.dayIndex === dayIndexOf(now));
  if (today.length === 0) return { status: 'dayOff', dateLabel };

  const nowMinutes = minutesOfDay(now);
  const remaining = today.filter((m) => m.endMinutes > nowMinutes);
  if (remaining.length === 0) return { status: 'dayOff', dateLabel };

  return {
    status: 'normal',
    dateLabel,
    notice: noticeFor(today, nowMinutes),
    rows: remaining.map((m, index) => ({
      timeRange: `${formatHhMm(m.startMinutes)}~${formatHhMm(m.endMinutes)}`,
      className: m.title,
      room: m.room,
      // Only the first row — the current or next class — is highlighted, the
      // same single-accent treatment the Figma frame uses.
      highlighted: index === 0,
    })),
  };
}

/**
 * "시간표" — the Mon–Fri week grid.
 *
 * `startMinutes` here is measured from {@link TIMETABLE_GRID_START_HOUR}, not
 * midnight, because that is where the widget's grid begins. Anything ending
 * before the grid starts is dropped; anything straddling the start is clamped
 * to it so it still appears, shortened.
 */
export function toTimetableProps(meetings: ClassMeeting[], now: Date): TimetableWidgetProps {
  const gridStart = TIMETABLE_GRID_START_HOUR * 60;
  const classesByDay: ClassBlock[][] = [[], [], [], [], []];

  for (const meeting of meetings) {
    if (meeting.dayIndex > 4) continue; // Mon–Fri grid; weekend classes have no column.
    if (meeting.endMinutes <= gridStart) continue;

    const start = Math.max(meeting.startMinutes, gridStart);
    classesByDay[meeting.dayIndex].push({
      startMinutes: start - gridStart,
      durationMinutes: meeting.endMinutes - start,
      className: meeting.title,
      room: meeting.room,
      color: colorFor(meeting.colorKey),
    });
  }

  if (classesByDay.every((day) => day.length === 0)) return { status: 'noTimetable' };

  const todayIndex = dayIndexOf(now);
  return {
    status: 'normal',
    classesByDay,
    todayIndex: todayIndex <= 4 ? todayIndex : undefined,
  };
}

/**
 * The instants today at which any of the schedule widgets would change — every
 * class start and end still ahead of `now`.
 *
 * This is what turns three widgets that look live into three widgets that need
 * one fetch a day. A caller that can schedule future work hands these to the
 * platform along with the props for each, and the widget advances through the
 * day on its own: iOS walks a timeline with no further network, and Android
 * can queue one-shot updates at the same instants.
 */
export function classBoundariesOf(meetings: ClassMeeting[], now: Date): Date[] {
  const today = meetings.filter((m) => m.dayIndex === dayIndexOf(now));
  const nowMinutes = minutesOfDay(now);
  const minutes = new Set<number>();

  for (const meeting of today) {
    if (meeting.startMinutes > nowMinutes) minutes.add(meeting.startMinutes);
    if (meeting.endMinutes > nowMinutes) minutes.add(meeting.endMinutes);
  }

  return [...minutes]
    .sort((a, b) => a - b)
    .map((m) => {
      const at = new Date(now);
      at.setHours(Math.floor(m / 60), m % 60, 0, 0);
      return at;
    });
}

// --- Fetch -----------------------------------------------------------------

/** Later year first, then later term — the portal's own semester ordering. */
const TERM_ORDER: Record<Term, number> = { FIRST: 0, SUMMER: 1, SECOND: 2, WINTER: 3 };

/**
 * Today, as the `YYYY-MM-DD` the semester calendar is written in.
 *
 * Compared as a string rather than parsed into a `Date`: the API's dates carry
 * no timezone, so parsing them would silently pick one, and "is today inside
 * this range" is a calendar question, not an instant one. Lexicographic order
 * is date order for this format.
 */
function localDateKey(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The semester the widgets should be showing.
 *
 * Tried in order:
 *
 * 1. The semester whose calendar contains today. This is the answer during
 *    term time and the only one that stays right when several semesters are
 *    marked `OPEN` (the server opens the next one for course registration
 *    while the current one is still running).
 * 2. The one the server calls `OPEN`, if the dates didn't settle it.
 * 3. The most recent semester that has already started — the vacation case,
 *    where the term that just ended is still what the user means by "my
 *    timetable", and is certainly better than the upcoming one, which is
 *    usually empty.
 *
 * Returns null only when the list is empty, which leaves the caller to fall
 * back to searching every timetable.
 */
export function currentSemesterOf(semesters: Semester[], now: Date): Semester | null {
  if (semesters.length === 0) return null;

  const today = localDateKey(now);

  const containingToday = semesters.find((s) => s.startDate <= today && today <= s.endDate);
  if (containingToday) return containingToday;

  const open = semesters.find((s) => s.status === 'OPEN');
  if (open) return open;

  const started = semesters
    .filter((s) => s.startDate <= today)
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  return started[0] ?? null;
}

/**
 * The 대표 시간표 — the timetable the widgets follow.
 *
 * `isPrimary` is per semester, not per account: a user who has set a primary
 * timetable for next semester as well has two, and picking "the most recent
 * primary" would put next semester's (usually empty) timetable on the home
 * screen mid-term. So the semester is chosen first and the primary is looked
 * up *within* it.
 *
 * Matching is by `semesterId` when the server sent one, falling back to
 * year + term, because those are what identify a semester in the timetable
 * list itself.
 *
 * A semester with timetables but no primary falls back to its first one —
 * the portal marks a user's first timetable in a semester primary on
 * creation, so this only comes up for data that predates that, and showing
 * *a* timetable beats showing none.
 */
export function pickPrimaryTimetable(
  timetables: TimeTableSummary[],
  semester: Semester | null,
): TimeTableSummary | null {
  const inSemester = semester
    ? timetables.filter((t) =>
        t.semesterId !== undefined && semester.id !== undefined
          ? t.semesterId === semester.id
          : t.year === semester.year && t.term === semester.term,
      )
    : [];

  if (inSemester.length > 0) {
    return inSemester.find((t) => t.isPrimary) ?? inSemester[0];
  }

  // No semester to go on, or nothing in it: the most recent primary anywhere
  // is the best remaining guess.
  return (
    timetables
      .filter((t) => t.isPrimary)
      .sort((a, b) => (a.year !== b.year ? b.year - a.year : TERM_ORDER[b.term] - TERM_ORDER[a.term]))[0] ??
    null
  );
}

/**
 * The user's 대표 시간표 for the current semester, flattened to meetings.
 *
 * Returns null when the data could not be fetched, and an empty array when the
 * user has a session but no timetable — the two are different widget states
 * (the caller renders `noTimetable` only for the latter), so they have to stay
 * distinguishable.
 *
 * Three calls, not one: the portal has no "my primary timetable" endpoint for
 * the current user (only `/api/timetables/friends/{id}/primary`, for someone
 * else's). So the semester is resolved from `/api/semesters`, the list is
 * fetched filtered to that semester, and the primary within it is expanded.
 */
export async function fetchClassMeetings(now: Date = new Date()): Promise<ClassMeeting[] | null> {
  // Not fatal on failure: without it the timetable list is fetched unfiltered
  // and `pickPrimaryTimetable` falls back to the most recent primary.
  const semesters = await getJson<Semester[]>('/api/semesters', { authenticated: true });
  const semester = currentSemesterOf(semesters ?? [], now);

  const timetables = await getJson<TimeTableSummary[]>('/api/timetables', {
    authenticated: true,
    // The server filters by year+term together or not at all.
    query: semester ? { year: semester.year, term: semester.term } : undefined,
  });
  if (timetables === null) return null;

  const primary = pickPrimaryTimetable(timetables, semester);
  if (!primary) return [];

  const detail = await getJson<TimeTableDetail>(`/api/timetables/${primary.id}`, {
    authenticated: true,
  });
  if (!detail) return null;

  return toClassMeetings(detail);
}
