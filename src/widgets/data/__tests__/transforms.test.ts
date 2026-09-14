/**
 * The widget data transforms.
 *
 * Every function under test is pure and takes `now` explicitly, which is the
 * point of the split: a widget's rendering depends entirely on what time it
 * is, and that is exactly the thing that is impossible to exercise against a
 * live device. Here the clock is an argument.
 */
import { describe, it, expect } from '@jest/globals';

import {
  currentMealWindow,
  mealBoundariesOf,
  toCafeteriaMenuProps,
} from '../cafeteria';
import { etaSecondsOf, formatEta, formatObservedAt, toBusArrivalProps } from '../busArrival';
import {
  colorFor,
  currentSemesterOf,
  formatRoom,
  dayIndexOf,
  pickPrimaryTimetable,
  formatHhMm,
  parseHhMm,
  toClassMeetings,
  toNextClassProps,
  toTimetableProps,
  toTodayClassesProps,
  type ClassMeeting,
} from '../timetable';

/** A Tuesday. */
const TUESDAY = (h: number, m = 0) => new Date(2026, 8, 1, h, m, 0, 0);

const MEETINGS: ClassMeeting[] = [
  { dayIndex: 1, startMinutes: 9 * 60, endMinutes: 10 * 60 + 15, title: '자료구조', room: '07-504', colorKey: 'course:1' },
  { dayIndex: 1, startMinutes: 16 * 60 + 30, endMinutes: 17 * 60 + 45, title: '디지털공학', room: '07-504', colorKey: 'course:2' },
  { dayIndex: 3, startMinutes: 13 * 60, endMinutes: 14 * 60, title: '인공지능개론', room: '07-308', colorKey: 'course:3' },
];

describe('time helpers', () => {
  it('round-trips HH:mm', () => {
    expect(parseHhMm('14:30')).toBe(870);
    expect(formatHhMm(870)).toBe('14:30');
    expect(formatHhMm(9 * 60)).toBe('09:00');
  });

  it('rejects anything that is not a valid HH:mm', () => {
    for (const bad of ['', '1430', '24:00', '12:60', 'aa:bb', '12:3']) {
      expect(parseHhMm(bad)).toBeNull();
    }
  });

  it('treats Monday as day 0, matching the timetable grid', () => {
    expect(dayIndexOf(new Date(2026, 7, 31, 12))).toBe(0); // Monday
    expect(dayIndexOf(TUESDAY(12))).toBe(1);
    expect(dayIndexOf(new Date(2026, 8, 6, 12))).toBe(6); // Sunday
  });
});

describe('toClassMeetings', () => {
  const detail = {
    id: 1,
    items: [
      {
        type: 'COURSE' as const,
        course: {
          courseOfferingId: 10,
          title: '자료구조',
          meetings: [
            { location: '07-504', day: 'TUESDAY' as const, startTime: '09:00', endTime: '10:15' },
          ],
        },
        customSchedule: null,
      },
      {
        type: 'CUSTOM' as const,
        course: null,
        customSchedule: {
          customScheduleId: 5,
          title: '알바',
          meetings: [
            { location: null, day: 'MONDAY' as const, startTime: '18:00', endTime: '22:00' },
          ],
        },
      },
    ],
  };

  it('flattens courses and custom schedules alike', () => {
    const meetings = toClassMeetings(detail);
    expect(meetings).toHaveLength(2);
    // Sorted by day, so the Monday custom entry comes first.
    expect(meetings[0]).toMatchObject({ dayIndex: 0, title: '알바', room: '' });
    expect(meetings[1]).toMatchObject({ dayIndex: 1, title: '자료구조', room: '07-504' });
  });

  it('drops meetings it cannot place rather than guessing', () => {
    const broken = {
      id: 1,
      items: [
        {
          type: 'COURSE' as const,
          course: {
            courseOfferingId: 1,
            title: '깨진수업',
            meetings: [
              { location: null, day: 'TUESDAY' as const, startTime: 'nope', endTime: '10:15' },
              { location: null, day: 'TUESDAY' as const, startTime: '11:00', endTime: '10:00' },
            ],
          },
          customSchedule: null,
        },
        // A course with no title is not renderable either.
        { type: 'COURSE' as const, course: { courseOfferingId: 2, title: '  ', meetings: [] }, customSchedule: null },
      ],
    };
    expect(toClassMeetings(broken)).toEqual([]);
  });
});

describe('colorFor', () => {
  it('is stable for the same course and spread across the palette', () => {
    expect(colorFor('course:10')).toBe(colorFor('course:10'));
    const assigned = new Set(Array.from({ length: 30 }, (_, i) => colorFor(`course:${i}`)));
    expect(assigned.size).toBeGreaterThan(3);
  });
});

describe('toNextClassProps', () => {
  it('reports the class in progress', () => {
    expect(toNextClassProps(MEETINGS, TUESDAY(9, 30))).toEqual({
      status: 'ongoing',
      className: '자료구조',
      location: '07-504',
      endsAtLabel: '10:15에 끝나요',
    });
  });

  it('reports the next class before it starts', () => {
    expect(toNextClassProps(MEETINGS, TUESDAY(8))).toMatchObject({
      status: 'upcoming',
      className: '자료구조',
      timeRange: '09:00–10:15',
    });
  });

  it('says the day is over rather than jumping to tomorrow', () => {
    expect(toNextClassProps(MEETINGS, TUESDAY(20)).status).toBe('doneForToday');
  });

  it('is a day off when nothing is scheduled', () => {
    expect(toNextClassProps(MEETINGS, new Date(2026, 8, 5, 12)).status).toBe('dayOff');
  });

  it('falls back to the online-class wording when a class has no room', () => {
    const online: ClassMeeting[] = [{ ...MEETINGS[0], room: '' }];
    expect(toNextClassProps(online, TUESDAY(8))).toMatchObject({ location: '온라인 수업' });
  });
});

describe('toTodayClassesProps', () => {
  it('lists only what is still to come, highlighting the first row', () => {
    const props = toTodayClassesProps(MEETINGS, TUESDAY(11));
    expect(props).toMatchObject({ status: 'normal', dateLabel: '9월 1일 화요일' });
    if (props.status !== 'normal') throw new Error('expected normal');
    expect(props.rows).toHaveLength(1);
    expect(props.rows[0]).toMatchObject({ className: '디지털공학', highlighted: true });
  });

  it('counts down to the next class in the header', () => {
    const props = toTodayClassesProps(MEETINGS, TUESDAY(8));
    expect(props).toMatchObject({ notice: '1시간 후 시작' });
    expect(toTodayClassesProps(MEETINGS, TUESDAY(8, 30))).toMatchObject({ notice: '30분 후 시작' });
    expect(toTodayClassesProps(MEETINGS, TUESDAY(9, 30))).toMatchObject({ notice: '수업 중' });
  });

  it('becomes a day off once the last class has ended', () => {
    expect(toTodayClassesProps(MEETINGS, TUESDAY(18)).status).toBe('dayOff');
  });
});

describe('toTimetableProps', () => {
  it('places classes relative to the grid start, not midnight', () => {
    const props = toTimetableProps(MEETINGS, TUESDAY(12));
    if (props.status !== 'normal') throw new Error('expected normal');
    // 09:00 with an 08:00 grid start = 60 minutes down the grid.
    expect(props.classesByDay[1][0]).toMatchObject({
      startMinutes: 60,
      durationMinutes: 75,
      className: '자료구조',
    });
    expect(props.todayIndex).toBe(1);
  });

  it('keeps a class that straddles the grid start, shortened', () => {
    const early: ClassMeeting[] = [
      { ...MEETINGS[0], startMinutes: 7 * 60 + 30, endMinutes: 8 * 60 + 30 },
    ];
    const props = toTimetableProps(early, TUESDAY(12));
    if (props.status !== 'normal') throw new Error('expected normal');
    expect(props.classesByDay[1][0]).toMatchObject({ startMinutes: 0, durationMinutes: 30 });
  });

  it('has no column for weekend classes', () => {
    const weekend: ClassMeeting[] = [{ ...MEETINGS[0], dayIndex: 5 }];
    expect(toTimetableProps(weekend, TUESDAY(12)).status).toBe('noTimetable');
  });
});

describe('bus arrival', () => {
  it('formats an ETA, collapsing anything imminent', () => {
    expect(formatEta(259)).toBe('4분 19초');
    expect(formatEta(240)).toBe('4분');
    expect(formatEta(30)).toBe('곧 도착');
    expect(formatEta(3700)).toBe('1시간 1분');
  });

  it('prefers the parsed seconds field but accepts the raw one', () => {
    expect(etaSecondsOf({ estimatedArrivalSeconds: 90 })).toBe(90);
    expect(etaSecondsOf({ arrivalEstimateTime: '120' })).toBe(120);
    expect(etaSecondsOf({ arrivalEstimateTime: 'n/a' })).toBeNull();
    expect(etaSecondsOf({})).toBeNull();
  });

  it('states when a reading was taken, as a clock time', () => {
    expect(formatObservedAt(new Date(2026, 0, 5, 18, 31).getTime())).toBe('18:31 기준');
    expect(formatObservedAt(new Date(2026, 0, 5, 9, 5).getTime())).toBe('09:05 기준');
    expect(formatObservedAt(new Date(2026, 0, 5, 0, 0).getTime())).toBe('00:00 기준');
  });

  it('anchors the countdown to when the estimate was observed, not to now', () => {
    const now = TUESDAY(12);
    const observedAt = now.getTime() - 60_000;
    const props = toBusArrivalProps(
      [{ routeNo: '6-1', estimatedArrivalSeconds: 300, observedAt }],
      '2번 출구',
      now,
    );
    if (props.status !== 'normal') throw new Error('expected normal');
    // 5 minutes after it was read, i.e. 4 minutes from now — not 5.
    expect(props.arrivals[0].arrivesAt).toBe(observedAt + 300_000);
    expect(props.arrivals[0].observedLabel).toBe(formatObservedAt(observedAt));
  });

  it('sorts by arrival, drops unusable rows, and keeps at most three', () => {
    const now = TUESDAY(12);
    const props = toBusArrivalProps(
      [
        { routeNo: '8', estimatedArrivalSeconds: 600, observedAt: now.getTime() },
        { routeNo: '6-1', estimatedArrivalSeconds: 30, observedAt: now.getTime() },
        { estimatedArrivalSeconds: 10, observedAt: now.getTime() },
        { routeNo: '순환41', estimatedArrivalSeconds: 900, observedAt: now.getTime() },
        { routeNo: '3', estimatedArrivalSeconds: 1200, observedAt: now.getTime() },
      ],
      '2번 출구',
      now,
    );
    if (props.status !== 'normal') throw new Error('expected normal');
    expect(props.arrivals.map((a) => a.route)).toEqual(['6-1', '8', '순환41']);
    expect(props.arrivals[0].soon).toBe(true);
  });

  it('has a dedicated state for nothing to show', () => {
    expect(toBusArrivalProps([], '2번 출구', TUESDAY(12)).status).toBe('noData');
  });
});

describe('cafeteria', () => {
  it('picks the meal being served, else the next one', () => {
    expect(currentMealWindow(TUESDAY(12))?.meal).toBe('lunch');
    expect(currentMealWindow(TUESDAY(9))?.meal).toBe('lunch');
    expect(currentMealWindow(TUESDAY(15))?.meal).toBe('dinner');
    expect(currentMealWindow(TUESDAY(21))).toBeNull();
  });

  it('marks whether the window is open right now', () => {
    expect(toCafeteriaMenuProps(['돈까스카레'], '제1학생식당', TUESDAY(12))).toMatchObject({
      status: 'normal',
      mealLabel: '점심',
      footer: '11:30–14:00 운영 중 · 더보기',
    });
    expect(toCafeteriaMenuProps(['돈까스카레'], '제1학생식당', TUESDAY(9))).toMatchObject({
      footer: '11:30–14:00 운영 예정 · 더보기',
    });
  });

  it('drops blank menu entries and falls back when nothing is left', () => {
    expect(toCafeteriaMenuProps(['  ', ''], '제1학생식당', TUESDAY(12))).toEqual({
      status: 'noMenu',
      cafeteriaName: '제1학생식당',
    });
    expect(toCafeteriaMenuProps(null, '제1학생식당', TUESDAY(12)).status).toBe('noMenu');
  });

  it('reports only the boundaries still ahead, in order', () => {
    const boundaries = mealBoundariesOf(TUESDAY(12)).map((d) => `${d.getHours()}:${d.getMinutes()}`);
    expect(boundaries).toEqual(['14:0', '17:30', '19:0']);
    expect(mealBoundariesOf(TUESDAY(21))).toEqual([]);
  });
});

describe('toCafeteriaMenuProps with the API\'s null slots', () => {
  const LUNCHTIME = new Date(2026, 8, 14, 12, 0);

  it('treats a slot array of nulls as no menu instead of throwing', () => {
    // Exactly what `/api/cafeterias` returns on a day with nothing served:
    // {"data":[null,null,null]}. This used to throw on `.trim()`, and
    // `Promise.allSettled` swallowed it, so the widget kept the last meal.
    const props = toCafeteriaMenuProps([null, null, null], '제1학생식당', LUNCHTIME);
    expect(props.status).toBe('noMenu');
  });

  it('keeps the real items when only some slots are null', () => {
    const props = toCafeteriaMenuProps([null, '돈까스카레', null, '순두부찌개'], '제1학생식당', LUNCHTIME);
    if (props.status !== 'normal') throw new Error('expected normal');
    expect(props.items).toEqual(['돈까스카레', '순두부찌개']);
  });
});

describe('currentSemesterOf', () => {
  const SEMESTERS = [
    { id: 1, year: 2026, term: 'FIRST' as const, status: 'CLOSED' as const, startDate: '2026-03-02', endDate: '2026-06-21' },
    { id: 2, year: 2026, term: 'SUMMER' as const, status: 'CLOSED' as const, startDate: '2026-06-22', endDate: '2026-07-12' },
    { id: 3, year: 2026, term: 'SECOND' as const, status: 'OPEN' as const, startDate: '2026-09-01', endDate: '2026-12-20' },
    { id: 4, year: 2026, term: 'WINTER' as const, status: 'UPCOMING' as const, startDate: '2026-12-21', endDate: '2027-02-10' },
  ];

  it('picks the semester whose calendar contains today', () => {
    expect(currentSemesterOf(SEMESTERS, new Date(2026, 8, 13))?.id).toBe(3);
    expect(currentSemesterOf(SEMESTERS, new Date(2026, 2, 2))?.id).toBe(1);
    // Last day of term is still in term.
    expect(currentSemesterOf(SEMESTERS, new Date(2026, 11, 20))?.id).toBe(3);
  });

  it('prefers the calendar over the server status when they disagree', () => {
    // Registration opens the next semester while this one is still running;
    // "OPEN" alone would jump the widget a semester ahead.
    const bothOpen = SEMESTERS.map((s) =>
      s.id === 4 ? { ...s, status: 'OPEN' as const } : s,
    );
    expect(currentSemesterOf(bothOpen, new Date(2026, 8, 13))?.id).toBe(3);
  });

  it('falls back to the OPEN semester when no calendar matches', () => {
    const gap = SEMESTERS.map((s) => (s.id === 3 ? { ...s, startDate: '2026-10-01' } : s));
    expect(currentSemesterOf(gap, new Date(2026, 8, 13))?.id).toBe(3);
  });

  it('falls back to the most recent started semester during a vacation', () => {
    const noneOpen = SEMESTERS.map((s) => ({ ...s, status: 'CLOSED' as const }));
    // Mid-August: after SUMMER ended, before SECOND begins.
    expect(currentSemesterOf(noneOpen, new Date(2026, 7, 15))?.id).toBe(2);
  });

  it('returns null for an empty list', () => {
    expect(currentSemesterOf([], new Date(2026, 8, 13))).toBeNull();
  });
});

describe('pickPrimaryTimetable', () => {
  const SECOND = { id: 3, year: 2026, term: 'SECOND' as const, status: 'OPEN' as const, startDate: '2026-09-01', endDate: '2026-12-20' };

  it('takes the primary within the current semester, not the latest one overall', () => {
    const timetables = [
      { id: 10, semesterId: 3, year: 2026, term: 'SECOND' as const, isPrimary: true },
      // Next semester already has a primary set; it must not win.
      { id: 11, semesterId: 4, year: 2026, term: 'WINTER' as const, isPrimary: true },
    ];
    expect(pickPrimaryTimetable(timetables, SECOND)?.id).toBe(10);
  });

  it('matches on year and term when the server sent no semesterId', () => {
    const timetables = [
      { id: 10, year: 2026, term: 'SECOND' as const, isPrimary: true },
      { id: 11, year: 2026, term: 'WINTER' as const, isPrimary: true },
    ];
    expect(pickPrimaryTimetable(timetables, SECOND)?.id).toBe(10);
  });

  it('falls back to the first timetable in the semester when none is primary', () => {
    const timetables = [
      { id: 10, semesterId: 3, year: 2026, term: 'SECOND' as const, isPrimary: false },
      { id: 11, semesterId: 3, year: 2026, term: 'SECOND' as const, isPrimary: false },
    ];
    expect(pickPrimaryTimetable(timetables, SECOND)?.id).toBe(10);
  });

  it('falls back to the most recent primary anywhere when the semester is unknown', () => {
    const timetables = [
      { id: 10, semesterId: 1, year: 2026, term: 'FIRST' as const, isPrimary: true },
      { id: 11, semesterId: 3, year: 2026, term: 'SECOND' as const, isPrimary: true },
    ];
    expect(pickPrimaryTimetable(timetables, null)?.id).toBe(11);
  });

  it('returns null when there is nothing to pick', () => {
    expect(pickPrimaryTimetable([], SECOND)).toBeNull();
  });
});

describe('formatRoom', () => {
  it('shortens the portal room name to building-room', () => {
    expect(formatRoom('제7호관 정보기술대학-505 강의실(중)-2')).toBe('7-505');
    expect(formatRoom('제28호관 도시과학대학-203')).toBe('28-203');
  });

  it('leaves anything else alone', () => {
    expect(formatRoom('07-504')).toBe('07-504');
    expect(formatRoom('선인장')).toBe('선인장');
    expect(formatRoom('')).toBe('');
  });

  it('is applied to meetings as they are flattened', () => {
    const meetings = toClassMeetings({
      id: 1,
      items: [
        {
          type: 'COURSE',
          course: {
            courseOfferingId: 9,
            title: '자연어처리',
            meetings: [{ location: '제7호관 정보기술대학-505 강의실(중)-2', day: 'MONDAY', startTime: '09:00', endTime: '10:15' }],
          },
          customSchedule: null,
        },
      ],
    });
    expect(meetings[0].room).toBe('7-505');
  });
});
