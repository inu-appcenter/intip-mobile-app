/**
 * Fetches the home screen widgets' data and pushes it to them.
 *
 * Widgets render from a snapshot, not from the network — see
 * `data/apiClient.ts` for why the fetching lives in the app process — so this
 * is the seam between the two. Everything here is safe to call at any time and
 * never throws: a refresh that fails leaves whatever the widget already had on
 * screen, which is always better than an error state the user can't act on.
 *
 * ## Timelines on both platforms
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
 * Glance has no equivalent of its own — a widget shows what the store last
 * held — so expo-widgets-glance supplies one: it keeps the same entries,
 * renders whichever is current by the clock, and schedules a repaint for each
 * later one. Android therefore gets the very same entries iOS does. What stays
 * Android-only is the refresh hook, which re-runs this data path when data
 * goes stale, and an entry can ask for it (`refresh`) at a moment the data is
 * known to run out — see the bus widget below.
 */
import { AppState, Platform } from 'react-native';

import { updateGlanceTimeline } from 'expo-widgets-glance';

import BusArrivalWidget from './BusArrivalWidget';
import CafeteriaMenuWidget from './CafeteriaMenuWidget';
import NextClassWidget from './NextClassWidget';
import TestWidget from './TestWidget';
import TimetableWidget from './TimetableWidget';
import TodayClassesWidget from './TodayClassesWidget';
import { BUS_FOREGROUND_POLL_MS } from './refreshIntervals';
import { fetchCafeteriaMenus, mealBoundariesOf, toCafeteriaMenuProps } from './data/cafeteria';
import {
  arrivalBoundariesOf,
  arrivalsForStop,
  arrivalRefreshMomentsOf,
  fetchBusArrivals,
  fetchBusStops,
  nearestStop,
  toBusArrivalProps,
  withObservedAt,
} from './data/busArrival';
import { hasSession } from './data/apiClient';
import { getWidgetPosition } from './data/location';
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
 * which moments matter. Both platforms get the same entries — see the module
 * doc.
 *
 * A boundary already in the past would make WidgetKit show a stale entry as
 * "current", so the list always starts at `now` and only ever moves forward.
 *
 * `refreshAt` (epoch ms) is when the widget should refetch. Android only: a
 * WidgetKit entry can't reach the network. A moment that isn't already a
 * boundary gets an entry of its own there (same props, just a wake-up), so a
 * refetch never has to wait for the next visual change.
 */
function push<P extends Record<string, unknown>>(
  widget: Pushable<P>,
  boundaries: Date[],
  at: (moment: Date) => P,
  now: Date,
  refreshAt: ReadonlySet<number> = new Set(),
): void {
  const moments = [now, ...boundaries.filter((b) => b.getTime() > now.getTime())];
  if (Platform.OS === 'ios') {
    widget.ios.updateTimeline(moments.map((date) => ({ date, props: at(date) })));
  } else if (Platform.OS === 'android') {
    const androidMoments = [
      ...new Set([
        ...moments.map((date) => date.getTime()),
        ...[...refreshAt].filter((ms) => ms > now.getTime()),
      ]),
    ]
      .sort((a, b) => a - b)
      .map((ms) => new Date(ms));
    updateGlanceTimeline(
      widget.name,
      androidMoments.map((date) => ({ date, props: at(date), refresh: refreshAt.has(date.getTime()) })),
    );
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
  const [stops, position] = await Promise.all([fetchBusStops(), getWidgetPosition()]);
  if (stops === null) return; // Network failure: keep the last good snapshot.

  // Re-picked on every refresh, so the widget follows the user from the
  // station to campus without them doing anything.
  const stop = nearestStop(stops, position);
  if (!stop) {
    push(BUS_ARRIVAL, [], () => ({ status: 'noData' as const }), now);
    return;
  }

  const fetched = await fetchBusArrivals(stop.bstopId);
  if (fetched === null) return; // Network failure: keep the last good snapshot.

  // Pinned to this fetch before any future entry is built: an item without an
  // upstream `observedAt` would otherwise be re-anchored to each entry's own
  // time, and its bus would never arrive.
  const arrivals = withObservedAt(arrivalsForStop(fetched, stop), now);

  // One entry per moment the list itself changes — a bus turning "곧 도착",
  // and a bus arriving and dropping off so the next one moves up. A single
  // entry left WidgetKit holding the fetch-time list forever: passed buses
  // stayed on screen with their timers counting back *up* ("12:21:26" the
  // next morning), and nothing new appeared until the app was opened again.
  // The countdown between those moments still ticks on its own.
  //
  // On Android, a shown bus's last stretch is also re-fetched every few
  // seconds, from "잠시후" until just past its due time — the only way to learn
  // it has actually gone, and to fill its row with the next bus. See
  // `arrivalRefreshMomentsOf`.
  push(
    BUS_ARRIVAL,
    arrivalBoundariesOf(arrivals, now),
    (at) => toBusArrivalProps(arrivals, stop.label, at),
    now,
    arrivalRefreshMomentsOf(arrivals, now),
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
  // Every cafeteria, since each widget picks its own — see `data/cafeteria.ts`.
  const menus = await fetchCafeteriaMenus(now);
  // Nothing came back at all: a network failure, so keep the last good snapshot.
  if (Object.values(menus).every((menu) => menu === null)) return;

  push(CAFETERIA_MENU, mealBoundariesOf(now), (at) => toCafeteriaMenuProps(menus, at), now);
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
