/**
 * Fetches the home screen widgets' data and pushes it to them.
 *
 * Widgets render from a snapshot, not from the network — see
 * `data/apiClient.ts` for why the fetching lives in the app process — so this
 * is the seam between the two. Everything here is safe to call at any time and
 * never throws: a refresh that fails leaves whatever the widget already had on
 * screen, which is always better than an error state the user can't act on.
 *
 * ## Why iOS gets timelines and Android gets snapshots
 *
 * The two platforms give a widget its future in opposite ways.
 *
 * WidgetKit takes a *timeline*: a list of future-dated entries it walks
 * through on its own clock, with no app process and no network. Almost
 * everything these widgets show is knowable in advance — a day's classes don't
 * move, meal windows are fixed — so iOS is handed the whole day at once and
 * needs one fetch per day rather than repeated polling. `WidgetTimelineEntry`
 * is what makes that possible, and it is the difference between a widget that
 * is correct at 3pm and one that is still showing 9am.
 *
 * Glance has no equivalent: a widget shows what the store last held, and the
 * only way to change it is to write again. So Android gets the current
 * snapshot, and the rest of its day is covered by the refresh hook in
 * expo-widgets-glance, which re-runs this data path when the launcher asks the
 * widget to update. Those are genuinely different mechanisms, and pretending
 * otherwise here would just move the difference somewhere harder to see.
 */
import { AppState, Platform } from 'react-native';

import { updateGlanceSnapshot } from 'expo-widgets-glance';

import BusArrivalWidget from './BusArrivalWidget';
import CafeteriaMenuWidget from './CafeteriaMenuWidget';
import NextClassWidget from './NextClassWidget';
import TestWidget from './TestWidget';
import TimetableWidget from './TimetableWidget';
import TodayClassesWidget from './TodayClassesWidget';
import { BUS_FOREGROUND_POLL_MS } from './refreshIntervals';
import {
  DEFAULT_CAFETERIA,
  fetchCafeteriaMenu,
  mealBoundariesOf,
  toCafeteriaMenuProps,
} from './data/cafeteria';
import {
  arrivalBoundariesOf,
  fetchBusArrivals,
  fetchDefaultStop,
  toBusArrivalProps,
  withObservedAt,
} from './data/busArrival';
import { hasSession } from './data/apiClient';
import {
  classBoundariesOf,
  fetchClassMeetings,
  toNextClassProps,
  toTimetableProps,
  toTodayClassesProps,
  type ClassMeeting,
} from './data/timetable';

/**
 * A widget that exists on both platforms, reduced to the two calls that differ.
 *
 * `updateTimeline` is iOS-only (`expo-widgets`' `Widget`); `updateGlanceSnapshot`
 * is the Android counterpart and takes a single set of props.
 */
type Pushable<P extends Record<string, unknown>> = {
  name: string;
  ios: { updateTimeline: (entries: { date: Date; props: P }[]) => void };
};

/**
 * Pushes one widget's data.
 *
 * `at(now)` is called once per boundary rather than being passed a prebuilt
 * list, so the caller describes *how* to render a moment and this decides
 * which moments matter. On Android only the first is used — see the module
 * doc.
 *
 * A boundary already in the past would make WidgetKit show a stale entry as
 * "current", so the list always starts at `now` and only ever moves forward.
 */
function push<P extends Record<string, unknown>>(
  widget: Pushable<P>,
  boundaries: Date[],
  at: (moment: Date) => P,
  now: Date,
): void {
  if (Platform.OS === 'ios') {
    const moments = [now, ...boundaries.filter((b) => b.getTime() > now.getTime())];
    widget.ios.updateTimeline(moments.map((date) => ({ date, props: at(date) })));
  } else if (Platform.OS === 'android') {
    updateGlanceSnapshot(widget.name, at(now));
  }
}

/**
 * Refreshes the three timetable-backed widgets from one fetch.
 *
 * All three read the same primary timetable, so fetching once and transforming
 * three ways is both cheaper and the only way they can't disagree with each
 * other about what the next class is.
 *
 * Being logged out is a state worth showing — the widgets have their own
 * `loggedOut` for it, and a shared device shouldn't keep a previous account's
 * classes on screen. A failed *request* is not: `getJson` returns null for a
 * timeout, a 401 and a missing session alike (see `data/apiClient.ts`), so the
 * session is checked separately rather than inferred from an empty result.
 * Without that split, one flaky request or one expired token replaces a
 * perfectly good timetable with "로그인이 필요해요" — observed happening on a
 * device that was, in fact, logged in.
 */
export async function refreshScheduleWidgets(now: Date = new Date()): Promise<void> {
  if (!(await hasSession())) {
    push(NEXT_CLASS, [], () => ({ status: 'loggedOut' as const }), now);
    push(TODAY_CLASSES, [], () => ({ status: 'noTimetable' as const, dateLabel: '' }), now);
    push(TIMETABLE, [], () => ({ status: 'noTimetable' as const }), now);
    return;
  }

  const meetings = await fetchClassMeetings();
  if (meetings === null) return; // Request failure: keep the last good snapshot.

  const boundaries = classBoundariesOf(meetings, now);
  push(NEXT_CLASS, boundaries, (at) => toNextClassProps(meetings, at), now);
  push(TODAY_CLASSES, boundaries, (at) => toTodayClassesProps(meetings, at), now);
  // The week grid itself doesn't change during the day — only which column is
  // "today" does — so it gets no boundaries.
  push(TIMETABLE, [], (at) => toTimetableProps(meetings, at), now);
}

/** Refreshes the 인입런 widget. See `data/busArrival.ts` on why this is not live. */
export async function refreshBusArrivalWidget(now: Date = new Date()): Promise<void> {
  const stop = await fetchDefaultStop();
  if (!stop) {
    push(BUS_ARRIVAL, [], () => ({ status: 'noData' as const }), now);
    return;
  }

  const fetched = await fetchBusArrivals(stop.bstopId);
  if (fetched === null) return; // Network failure: keep the last good snapshot.

  // Pinned to this fetch before any future entry is built: an item without an
  // upstream `observedAt` would otherwise be re-anchored to each entry's own
  // time, and its bus would never arrive.
  const arrivals = withObservedAt(fetched, now);

  // One entry per moment the list itself changes — a bus turning "곧 도착",
  // and a bus arriving and dropping off so the next one moves up. A single
  // entry left WidgetKit holding the fetch-time list forever: passed buses
  // stayed on screen with their timers counting back *up* ("12:21:26" the
  // next morning), and nothing new appeared until the app was opened again.
  // The countdown between those moments still ticks on its own.
  push(
    BUS_ARRIVAL,
    arrivalBoundariesOf(arrivals, now),
    (at) => toBusArrivalProps(arrivals, stop.stopName, at),
    now,
  );
}

/**
 * Ties widget refreshes to the app's lifecycle. Returns the cleanup.
 *
 * - **Leaving (→ background): every widget is refreshed.** This is the moment
 *   the home screen — and the widgets on it — comes into view, and the moment
 *   anything the user just changed in the app (a timetable edited in the
 *   WebView, say) should show up there. iOS keeps the JS running for a few
 *   seconds after backgrounding, which is ample for these few GETs on a normal
 *   connection; on a very slow one the refresh may be cut off, and the widget
 *   keeps what it had.
 * - **In the foreground: the bus widget is polled** every
 *   {@link BUS_FOREGROUND_POLL_MS}, and refreshed straight away on return. It
 *   is the only widget whose data goes stale in minutes, and the foreground is
 *   the only time iOS lets anything like live refresh happen — once the app is
 *   gone a widget cannot fetch on its own (see the module doc). Timeline
 *   entries keep it honest in between.
 *
 * Only `background` triggers the leave refresh, not `inactive`: iOS passes
 * through `inactive` for the app switcher and Control Center too, which are
 * not the user leaving.
 */
export function watchAppLifecycleForWidgets(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;

  const start = () => {
    if (timer) return;
    timer = setInterval(() => void refreshBusArrivalWidget(), BUS_FOREGROUND_POLL_MS);
  };
  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  if (AppState.currentState === 'active') start();
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void refreshBusArrivalWidget();
      start();
      return;
    }
    stop();
    if (state === 'background') void refreshAllWidgets();
  });

  return () => {
    stop();
    subscription.remove();
  };
}

/** Refreshes the 학식 메뉴 widget, including today's remaining meal switches. */
export async function refreshCafeteriaMenuWidget(now: Date = new Date()): Promise<void> {
  const menu = await fetchCafeteriaMenu(DEFAULT_CAFETERIA, now);
  if (menu === null) return; // Network failure: keep the last good snapshot.

  push(
    CAFETERIA_MENU,
    mealBoundariesOf(now),
    (at) => toCafeteriaMenuProps(menu, DEFAULT_CAFETERIA, at),
    now,
  );
}

/**
 * Refreshes every widget.
 *
 * Run on app foreground and after a login syncs a session. Failures are
 * per-widget and independent — `allSettled`, not `all`, so a bus API outage
 * doesn't also cost the user their timetable.
 */
export async function refreshAllWidgets(now: Date = new Date()): Promise<void> {
  await Promise.allSettled([
    refreshScheduleWidgets(now),
    refreshBusArrivalWidget(now),
    refreshCafeteriaMenuWidget(now),
  ]);
}

/**
 * Pushes a snapshot into the test countdown widget.
 *
 * iOS-only: `TestWidget` is a test bed with no Android counterpart, not one of
 * the designed widgets, so there is no `updateGlanceSnapshot` call to pair here.
 */
export function refreshTestWidget(): void {
  if (Platform.OS !== 'ios') return;

  const now = Date.now();
  TestWidget.updateSnapshot({
    label: '테스트 카운트다운',
    targetAt: now + 60 * 60 * 1000,
    updatedAt: now,
  });
}

// Declared after the functions purely so the exported API reads first; these
// exist to give `push` one object per widget instead of branching on name.
const NEXT_CLASS = { name: 'NextClassWidget', ios: NextClassWidget };
const TODAY_CLASSES = { name: 'TodayClassesWidget', ios: TodayClassesWidget };
const TIMETABLE = { name: 'TimetableWidget', ios: TimetableWidget };
const BUS_ARRIVAL = { name: 'BusArrivalWidget', ios: BusArrivalWidget };
const CAFETERIA_MENU = { name: 'CafeteriaMenuWidget', ios: CafeteriaMenuWidget };

/** Re-exported for callers that only want the shape, e.g. tests. */
export type { ClassMeeting };
