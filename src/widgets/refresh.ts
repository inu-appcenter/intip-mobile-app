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
 * needs one fetch rather than repeated polling. `WidgetTimelineEntry` is what
 * makes that possible, and it is the difference between a widget that is
 * correct at 3pm and one that is still showing 9am.
 *
 * The entries reach past today. Nothing refreshes an iOS widget while the app
 * is closed, so one handed only today's entries shows yesterday all of
 * tomorrow: the schedule widgets get two weeks (a timetable repeats weekly),
 * the cafeteria widget every day the server has published, and whatever can't
 * be known in advance ends in an entry that says so instead of a stale one.
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

import { API_BASE_URL } from '../config/env';

import BusArrivalWidget, {
  BusStopWidget,
  type BusArrivalRefreshSource,
  type BusArrivalSnapshot,
  type BusStopRefreshSource,
} from './BusArrivalWidget';
import CafeteriaMenuWidget from './CafeteriaMenuWidget';
import NextClassWidget from './NextClassWidget';
import TimetableWidget from './TimetableWidget';
import TodayClassesWidget from './TodayClassesWidget';
import { BUS_FOREGROUND_POLL_MS, FULL_REFRESH_MIN_INTERVAL_MS } from './refreshIntervals';
import { cafeteriaBoundariesOf, cafeteriaPropsAt, fetchCafeteriaDays } from './data/cafeteria';
import {
  arrivalBoundariesOf,
  arrivalsForStop,
  arrivalRefreshMomentsOf,
  busStopTargetsOf,
  earliestArrivals,
  fetchBusArrivals,
  fetchBusStops,
  nearestStop,
  toBusArrivalProps,
  withObservedAt,
} from './data/busArrival';
import { sessionState } from './data/apiClient';
import { getWidgetPosition } from './data/location';
import {
  classBoundariesOf,
  dayBoundariesOf,
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
 * classes on screen. Not knowing is not: `getJson` returns null for a timeout,
 * a 401 and a missing session alike (see `data/apiClient.ts`), so the session
 * is checked separately, and only a definite "no session" clears the widgets.
 * `unknown` — the keychain is locked because iOS launched the app in the
 * background on a locked phone, or the token refresh got no answer — leaves
 * them alone. Treating it as logged out replaced a perfectly good timetable
 * with "로그인이 필요해요" on devices that were, in fact, logged in.
 */
export async function refreshScheduleWidgets(now: Date = new Date()): Promise<void> {
  const session = await sessionState();
  if (session === 'unknown') return; // Keep the last good snapshot.
  if (session === 'none') {
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
  // "today" does — so it changes at midnight and nowhere else.
  push(TIMETABLE, dayBoundariesOf(now), (at) => toTimetableProps(meetings, at), now);
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

  // Lets the iOS widget extension refetch this same stop when its refresh
  // icon is tapped (see `plugins/widget-ios/BusArrivalRefresh.swift`). Carried
  // on every entry, `noData` included — that is when a refresh matters most.
  const source: BusArrivalRefreshSource = {
    apiBaseUrl: API_BASE_URL,
    bstopId: stop.bstopId,
    stopLabel: stop.label,
    routeIds: stop.routeIds,
  };

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
    (at) => ({ ...toBusArrivalProps(arrivals, stop.label, at), source }),
    now,
    arrivalRefreshMomentsOf(arrivals, now),
  );
}

/**
 * How many upcoming buses per stop the 정류장 선택 snapshot keeps. One more than
 * the three rows on screen, so the list stays full after the first arrives.
 */
const BUS_STOP_ARRIVALS_KEPT = 4;

/**
 * The last arrivals each stop returned. A stop whose request fails is rendered
 * from these instead of being blanked: they are absolute times, so they age
 * into "새로고침이 필요해요" on their own rather than lying.
 */
const lastStopArrivals = new Map<string, ReturnType<typeof withObservedAt>>();

/**
 * Refreshes the 정류장 선택 widget — every selectable stop in one snapshot,
 * since which one a widget shows is known only to the widget.
 *
 * One request per stop, which is why this is not part of the foreground poll
 * (see {@link watchAppLifecycleForWidgets}): it runs with the other widgets,
 * and on iOS the widget's own refresh icon refetches in the extension.
 */
export async function refreshBusStopWidget(now: Date = new Date()): Promise<void> {
  const stops = await fetchBusStops();
  if (stops === null) return; // Network failure: keep the last good snapshot.

  const targets = busStopTargetsOf(stops);
  const fetched = await Promise.all(targets.map((target) => fetchBusArrivals(target.bstopId)));
  if (fetched.every((items) => items === null)) return;

  const arrivalsById = new Map<string, ReturnType<typeof withObservedAt>>();
  targets.forEach((target, index) => {
    const items = fetched[index];
    if (items !== null) {
      const pinned = withObservedAt(arrivalsForStop(items, target), now);
      lastStopArrivals.set(target.bstopId, earliestArrivals(pinned, now, BUS_STOP_ARRIVALS_KEPT));
    }
    arrivalsById.set(target.id, lastStopArrivals.get(target.bstopId) ?? []);
  });

  const source: BusStopRefreshSource = { apiBaseUrl: API_BASE_URL, stops: targets };
  const boundaries = [
    ...new Set([...arrivalsById.values()].flatMap((items) => arrivalBoundariesOf(items, now).map((d) => d.getTime()))),
  ]
    .sort((a, b) => a - b)
    .map((ms) => new Date(ms));

  push(
    BUS_STOP,
    boundaries,
    (at) => {
      const snapshots: Record<string, BusArrivalSnapshot> = {};
      for (const target of targets) {
        snapshots[target.id] = toBusArrivalProps(arrivalsById.get(target.id) ?? [], target.stopLabel, at);
      }
      return { stops: snapshots, source };
    },
    now,
  );
}

/**
 * Ties widget refreshes to the app's lifecycle. Returns the cleanup.
 *
 * - **Arriving (→ active): every widget is refreshed, at most once per
 *   {@link FULL_REFRESH_MIN_INTERVAL_MS}.** An app kept in memory for days is
 *   never launched, so without this its only full refresh was the one below —
 *   a dozen requests racing iOS's suspension.
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
      // The full refresh includes the bus widget; when it is skipped as too
      // recent, the bus widget still gets its own.
      void refreshAllWidgetsIfStale(FULL_REFRESH_MIN_INTERVAL_MS).then((ran) => {
        if (!ran) void refreshBusArrivalWidget();
      });
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

/** Refreshes the 학식 메뉴 widget: every meal switch of every day the server has published. */
export async function refreshCafeteriaMenuWidget(now: Date = new Date()): Promise<void> {
  // Every cafeteria, since each widget picks its own — see `data/cafeteria.ts`.
  const days = await fetchCafeteriaDays(now);
  if (days === null) return; // Network failure: keep the last good snapshot.

  push(CAFETERIA_MENU, cafeteriaBoundariesOf(days), (at) => cafeteriaPropsAt(days, at), now);
}

/** When {@link refreshAllWidgets} last started, epoch ms. Per process. */
let lastFullRefreshAt = 0;

/**
 * Refreshes every widget.
 *
 * Run on app launch, on the way to the background, and (throttled) on the way
 * back. Failures are per-widget and independent — `allSettled`, not `all`, so
 * a bus API outage doesn't also cost the user their timetable.
 */
export async function refreshAllWidgets(now: Date = new Date()): Promise<void> {
  lastFullRefreshAt = Date.now();
  await Promise.allSettled([
    refreshScheduleWidgets(now),
    refreshBusArrivalWidget(now),
    refreshBusStopWidget(now),
    refreshCafeteriaMenuWidget(now),
  ]);
}

/**
 * {@link refreshAllWidgets}, unless one already ran within `maxAgeMs`. Resolves
 * to whether it ran.
 *
 * For triggers that fire far more often than the data changes — every return
 * to the app, every background push.
 */
export async function refreshAllWidgetsIfStale(maxAgeMs: number): Promise<boolean> {
  if (Date.now() - lastFullRefreshAt < maxAgeMs) return false;
  await refreshAllWidgets();
  return true;
}

// Declared after the functions purely so the exported API reads first; these
// exist to give `push` one object per widget instead of branching on name.
const NEXT_CLASS = { name: 'NextClassWidget', ios: NextClassWidget };
const TODAY_CLASSES = { name: 'TodayClassesWidget', ios: TodayClassesWidget };
const TIMETABLE = { name: 'TimetableWidget', ios: TimetableWidget };
const BUS_ARRIVAL = { name: 'BusArrivalWidget', ios: BusArrivalWidget };
const BUS_STOP = { name: 'BusStopWidget', ios: BusStopWidget };
const CAFETERIA_MENU = { name: 'CafeteriaMenuWidget', ios: CafeteriaMenuWidget };

/** Re-exported for callers that only want the shape, e.g. tests. */
export type { ClassMeeting };
