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
  menuColumnsOf,
  toCafeteriaMenuProps,
  toCafeteriaSnapshot,
} from '../cafeteria';
import {
  arrivalBoundariesOf,
  arrivalsForStop,
  arrivalRefreshMomentsOf,
  busStopsOf,
  distanceMeters,
  nearestStop,
  etaSecondsOf,
  formatEta,
  formatObservedAt,
  toBusArrivalProps,
  withObservedAt,
} from '../busArrival';
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
    expect(formatEta(30)).toBe('잠시후');
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

describe('nearest bus stop', () => {
  // Real coordinates from /api/buses/routes.
  const ROUTES = [
    {
      routeId: '165000012',
      startBstopId: '164000395',
      startBstopAlias: '2번출구',
      stops: [{ bstopId: '164000395', latitude: 37.38534766063011, longitude: 126.6388477378916 }],
    },
    {
      routeId: '165000020',
      startBstopId: '164000395',
      startBstopAlias: '2번출구',
      stops: [{ bstopId: '164000395', latitude: 37.38534766063011, longitude: 126.6388477378916 }],
    },
    {
      routeId: '165000012',
      startBstopId: '164000385',
      startBstopAlias: '정문(길 건너)',
      stops: [{ bstopId: '164000385', latitude: 37.3783228251565, longitude: 126.63467645770007 }],
    },
    { routeId: '1', startBstopId: '999', stops: [{ bstopId: '999', latitude: 200000, longitude: 400000 }] },
  ];
  const ALIASES = [{ bstopId: '164000385', stopAlias: '정문' }];

  it('builds one stop per starting stop, with its routes and the alias label', () => {
    const stops = busStopsOf(ROUTES, ALIASES);
    expect(stops.map((s) => [s.bstopId, s.label, s.routeIds])).toEqual([
      ['164000395', '2번출구', ['165000012', '165000020']],
      // Alias preferred over the route's own name; TM coordinates dropped.
      ['164000385', '정문', ['165000012']],
    ]);
  });

  it('picks the stop closest to the user, or the first when there is no position', () => {
    const stops = busStopsOf(ROUTES, ALIASES);
    // 인천대 정문 앞.
    expect(nearestStop(stops, { latitude: 37.3775, longitude: 126.635 })?.bstopId).toBe('164000385');
    expect(nearestStop(stops, null)?.bstopId).toBe('164000395');
    expect(nearestStop([], null)).toBeNull();
  });

  it('measures distance in meters', () => {
    const meters = distanceMeters(
      { latitude: 37.38534766063011, longitude: 126.6388477378916 },
      { latitude: 37.3783228251565, longitude: 126.63467645770007 },
    );
    expect(meters).toBeGreaterThan(800);
    expect(meters).toBeLessThan(900);
  });

  it("keeps only arrivals for the stop's own routes", () => {
    const [station] = busStopsOf(ROUTES, ALIASES);
    const items = [
      { routeId: '165000012', routeNo: '8' },
      { routeId: '161000027', routeNo: '4401' },
      { routeNo: 'no id' },
    ];
    expect(arrivalsForStop(items, station).map((i) => i.routeNo)).toEqual(['8']);
    expect(arrivalsForStop(items, { ...station, routeIds: [] })).toHaveLength(3);
  });
});

describe('cafeteria', () => {
  const LUNCH_ONLY = ['-', '돈까스카레', '-'];
  const SATURDAY = (h: number, m = 0) => new Date(2026, 8, 5, h, m, 0, 0);
  const STUDENT = { name: '학생식당' };

  it('picks the meal being served, else the next one', () => {
    expect(currentMealWindow(TUESDAY(8, 30))?.meal).toBe('breakfast');
    expect(currentMealWindow(TUESDAY(12))?.meal).toBe('lunch');
    expect(currentMealWindow(TUESDAY(10))?.meal).toBe('lunch');
    expect(currentMealWindow(TUESDAY(15))?.meal).toBe('dinner');
    expect(currentMealWindow(TUESDAY(21))).toBeNull();
  });

  it('shows the menu only while the window is open', () => {
    expect(toCafeteriaSnapshot(LUNCH_ONLY, STUDENT, TUESDAY(12))).toMatchObject({
      status: 'normal',
      mealLabel: '점심',
      footer: '11:30–14:00 운영 중 · 더보기',
    });
  });

  it('counts down to the next meal once the cafeteria is closed', () => {
    const slots = ['-', '[1코너(백반)]\n돈까스카레', '[1코너(백반)]\n제육볶음\n된장찌개'];
    // Before the first meal of the day nothing has closed yet.
    expect(toCafeteriaSnapshot(slots, STUDENT, TUESDAY(10))).toEqual({
      status: 'closed',
      cafeteriaName: '학생식당',
      badge: '운영 전',
      nextLabel: '다음 점심 11:30부터',
      preview: '돈까스카레',
    });
    expect(toCafeteriaSnapshot(slots, STUDENT, TUESDAY(15))).toMatchObject({
      badge: '운영 종료',
      nextLabel: '다음 저녁 17:30부터',
      preview: '제육볶음 · 된장찌개',
    });
    // Past the last meal there is nothing left today to count down to.
    expect(toCafeteriaSnapshot(slots, STUDENT, TUESDAY(21))).toMatchObject({
      status: 'closed',
      nextLabel: '오늘 운영이 끝났어요',
      preview: '',
    });
  });

  it('skips meals the cafeteria does not serve', () => {
    // At breakfast time with no breakfast, lunch is next.
    expect(toCafeteriaSnapshot(LUNCH_ONLY, STUDENT, TUESDAY(8, 30))).toMatchObject({
      status: 'closed',
      nextLabel: '다음 점심 11:30부터',
    });
    // After lunch with no dinner, the day is over.
    expect(toCafeteriaSnapshot(LUNCH_ONLY, STUDENT, TUESDAY(15))).toMatchObject({
      status: 'closed',
      nextLabel: '오늘 운영이 끝났어요',
    });
  });

  it('skips a meal that has none of the option\'s corners', () => {
    const slots = ['-', '[1코너(백반)]\n제육볶음', '-'];
    const option = { name: '학생식당', corners: ['4코너', '5코너'] };
    expect(toCafeteriaSnapshot(slots, option, TUESDAY(12)).status).toBe('notOperating');
  });

  it('reports a day with nothing posted as not operating', () => {
    expect(toCafeteriaSnapshot(['  ', '-', ''], STUDENT, TUESDAY(12))).toEqual({
      status: 'notOperating',
      cafeteriaName: '학생식당',
      message: '오늘은 운영하지 않아요',
    });
    // Exactly what `/api/cafeterias` returns for a name it doesn't know, or a
    // day with nothing served. `.trim()` on these used to throw.
    expect(toCafeteriaSnapshot([null, null, null], STUDENT, SATURDAY(12))).toMatchObject({
      status: 'notOperating',
      message: '주말에는 운영하지 않아요',
    });
    // A failed request is not a closed cafeteria.
    expect(toCafeteriaSnapshot(null, STUDENT, TUESDAY(12))).toEqual({
      status: 'notOperating',
      cafeteriaName: '학생식당',
      message: '메뉴를 불러오지 못했어요',
    });
  });

  it('builds a snapshot for every option, keyed by configuration id', () => {
    const props = toCafeteriaMenuProps({ 학생식당: LUNCH_ONLY }, TUESDAY(12));
    expect(Object.keys(props.cafeterias)).toEqual([
      'student12',
      'student45',
      'staff2',
      'dorm1',
      'education',
      'bldg27',
      'dorm2',
    ]);
    expect(props.cafeterias.student45).toMatchObject({ status: 'normal', cafeteriaName: '학생식당' });
    expect(props.cafeterias.dorm1).toMatchObject({ status: 'notOperating', cafeteriaName: '제1기숙사식당' });
  });

  it('never puts null in the props', () => {
    // iOS keeps props in UserDefaults, which rejects null outright: one
    // untitled column's `title: null` made every push of this widget throw.
    const props = toCafeteriaMenuProps(
      { 학생식당: ['-', '설렁탕 반반왕만두찜 매콤어묵볶음 양파초절임 쌀밥 배추김치', '-'] },
      TUESDAY(12),
    );
    expect(JSON.stringify(props)).not.toContain('null');
  });

  it('reports only the boundaries still ahead, in order', () => {
    const boundaries = mealBoundariesOf(TUESDAY(12)).map((d) => `${d.getHours()}:${d.getMinutes()}`);
    expect(boundaries).toEqual(['14:0', '17:30', '19:0']);
    expect(mealBoundariesOf(TUESDAY(21))).toEqual([]);
  });
});

describe('menuColumnsOf', () => {
  const CORNERS =
    '[1코너(백반)]\n고사리제육볶음\n미역국\n쑥갓두부무침\n표고버섯볶음\n6,500원 (구성원 5,500원)\n1246kcal\n\n' +
    '[2코너(일품)]\n짬뽕\n콘소메맛 지파이튀김\n7,500원 (구성원 6,500원)\n1615kcal\n\n' +
    '[국밥]\n수육국밥 / 순대국밥\n7,500(구성원 6,500원)\n1153kcal 1210kcal\n\n' +
    '[4코너(일품)]\n새우튀김덮밥\n902kcal\n\n' +
    '[5코너(고급일품)]\n뚝) 치즈불닭\n8,500원 (구성원 7,500원)\n1551kcal';

  it('breaks a one-line menu into dishes under the meal, cut to two lines and …', () => {
    // Production's shape, and what rendered as one long line on device.
    expect(
      menuColumnsOf('설렁탕 반반왕만두찜 매콤어묵볶음 양파초절임 쌀밥 배추김치 6,500원 (구성원 5,500원) 1250kcal', undefined, '석식'),
    ).toEqual([{ title: '석식', items: ['설렁탕', '반반왕만두찜', '…'] }]);
  });

  it('keeps a short menu whole, dropping price and calorie lines', () => {
    expect(menuColumnsOf('설렁탕\n반반왕만두찜\n6,500원 (구성원 5,500원)\n1250kcal', undefined, '석식')).toEqual([
      { title: '석식', items: ['설렁탕', '반반왕만두찜'] },
    ]);
    expect(menuColumnsOf('설렁탕\n반반왕만두찜\n쌀밥', undefined, '석식')).toEqual([
      { title: '석식', items: ['설렁탕', '반반왕만두찜', '쌀밥'] },
    ]);
  });

  it('gives the option\'s two corners a column each, without 국밥', () => {
    expect(menuColumnsOf(CORNERS, ['1코너', '2코너'])).toEqual([
      { title: '1코너(백반)', items: ['고사리제육볶음', '미역국', '…'] },
      { title: '2코너(일품)', items: ['짬뽕', '콘소메맛 지파이튀김'] },
    ]);
    expect(menuColumnsOf(CORNERS, ['4코너', '5코너'])).toEqual([
      { title: '4코너(일품)', items: ['새우튀김덮밥'] },
      { title: '5코너(고급일품)', items: ['뚝) 치즈불닭'] },
    ]);
  });

  it('shows a pick-one menu as its choices next to the shared dishes', () => {
    const text = '[선택1] 육개장\n[선택2] 차슈덮밥(pork), 우동국물\n\n[공통]\n백순대볶음(pork)\n야채계란전\n8,000원(구성원 7,000원)\n1,103/1,310kcal';
    expect(menuColumnsOf(text)).toEqual([
      { title: '선택', items: ['육개장', '차슈덮밥(pork), 우동국물'] },
      { title: '공통', items: ['백순대볶음(pork)', '야채계란전'] },
    ]);
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

describe('bus arrivals over time', () => {
  const FETCHED = TUESDAY(9, 0);
  const at = (seconds: number) => new Date(FETCHED.getTime() + seconds * 1000);
  const ITEMS = withObservedAt(
    [
      { routeNo: '8', estimatedArrivalSeconds: 120 },
      { routeNo: '16', estimatedArrivalSeconds: 600 },
      { routeNo: '순환41', estimatedArrivalSeconds: 900 },
      { routeNo: '58', estimatedArrivalSeconds: 1500 },
    ],
    FETCHED,
  );

  it('drops a bus once it has arrived and moves the next one up', () => {
    const props = toBusArrivalProps(ITEMS, '정류장', at(130));
    if (props.status !== 'normal') throw new Error('expected normal');
    // 8 has arrived; the fourth bus now has room.
    expect(props.arrivals.map((a) => a.route)).toEqual(['16', '순환41', '58']);
  });

  it('works the estimate out against the rendered moment, not the fetch', () => {
    const props = toBusArrivalProps(ITEMS, '정류장', at(90));
    if (props.status !== 'normal') throw new Error('expected normal');
    expect(props.arrivals[0]).toMatchObject({ route: '8', eta: '잠시후', soon: true });
    // Still stamped with when the data was actually read.
    expect(props.arrivals[0].observedLabel).toBe('09:00 기준');
  });

  it('reports no data once every known bus has arrived', () => {
    expect(toBusArrivalProps(ITEMS, '정류장', at(2000)).status).toBe('noData');
  });

  it('pins a missing observedAt to the fetch so future entries do not drift', () => {
    const later = toBusArrivalProps(ITEMS, '정류장', at(300));
    if (later.status !== 'normal') throw new Error('expected normal');
    expect(later.arrivals[0].arrivesAt).toBe(FETCHED.getTime() + 600_000);
  });

  it('lists each "잠시후" flip and each arrival, future only, in order', () => {
    const boundaries = arrivalBoundariesOf(ITEMS, at(100)).map((d) => (d.getTime() - FETCHED.getTime()) / 1000);
    // 8's soon-flip (60s) is already past at 100s; its arrival (120s) is not.
    expect(boundaries).toEqual([120, 540, 600, 840, 900, 1440, 1500]);
  });

  it('polls each on-screen bus from "잠시후" until just past its due time', () => {
    const seconds = (moments: Set<number>) =>
      [...moments].map((ms) => (ms - FETCHED.getTime()) / 1000).sort((a, b) => a - b);
    // Every 20s from 60s before arrival through 30s after it.
    expect(seconds(arrivalRefreshMomentsOf(ITEMS, at(0)))).toEqual([
      60, 80, 100, 120, 140, // 8, due at 120
      540, 560, 580, 600, 620, // 16, due at 600
      840, 860, 880, 900, 920, // 순환41, due at 900
      1440, 1460, 1480, 1500, 1520, // 58, due at 1500
    ]);
    // Already inside 8's window: only its remaining checks are left.
    expect(seconds(arrivalRefreshMomentsOf(ITEMS, at(100))).slice(0, 3)).toEqual([120, 140, 540]);
  });

  it('does not poll for a bus below the three rows on screen', () => {
    const bunched = withObservedAt(
      [100, 110, 120, 130].map((estimatedArrivalSeconds, index) => ({ routeNo: `${index}`, estimatedArrivalSeconds })),
      FETCHED,
    );
    const moments = [...arrivalRefreshMomentsOf(bunched, at(0))].map((ms) => (ms - FETCHED.getTime()) / 1000);
    // The fourth bus (due 130) opens its window at 70s behind three buses still
    // to come, so its last check at 150s never appears.
    expect(moments.sort((a, b) => a - b)).toEqual([40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140]);
  });
});
