/**
 * Bus arrival data for the 인입런 widget.
 *
 * Unauthenticated — `/api/buses/*` needs no session, so this widget keeps
 * working when nobody is logged in on the device, unlike the schedule ones.
 *
 * The hard part here is not the fetch, it is that **a home screen widget
 * cannot show live bus arrivals.** Neither platform will refresh a widget
 * anywhere near once a minute: Android's WorkManager floor is 15 minutes and
 * Doze stretches it further, and iOS hands out a limited daily budget of
 * timeline reloads. A snapshot saying "4분 19초" is a lie within a minute of
 * being written.
 *
 * So the snapshot carries an *absolute arrival instant* (`arrivesAt`) rather
 * than a duration, and each platform renders it as well as it can:
 *
 * - iOS can count down to it with no further refreshes at all — WidgetKit
 *   renders a relative/timer text on its own clock.
 * - Android does the same via a RemoteViews Chronometer, which the launcher
 *   ticks without waking the app (see expo-widgets-glance's
 *   `TickingCountdown`).
 *
 * `toBusArrivalProps` therefore emits both, and the widget decides. The
 * staleness label is not an apology for a limitation — a countdown that ticks
 * is still counting toward an estimate someone made minutes ago, and the
 * timestamp is the only thing on the widget that says when.
 */
import type { BusArrivalWidgetProps } from '../BusArrivalWidget';
import { getJson } from './apiClient';

// --- API shape (subset of inu-portal-web's `busArrival.ts`) ----------------

type BusArrivalApiItem = {
  routeId?: string;
  routeNo?: string;
  arrivalEstimateTime?: string | number;
  estimatedArrivalSeconds?: number;
  estimationNotice?: string;
  observedAt?: number;
  lastBusYn?: string;
};

/**
 * Under this many seconds the design says "잠시후" instead of a countdown —
 * a number that small has more error than signal, and it is what the rider
 * actually needs to know.
 */
export const ARRIVING_SOON_SECONDS = 60;

/** Seconds → `"4분 19초"`, or `"잠시후"` when it is close enough. */
export function formatEta(seconds: number): string {
  if (seconds <= ARRIVING_SOON_SECONDS) return '잠시후';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
  return rest === 0 ? `${minutes}분` : `${minutes}분 ${rest}초`;
}

/**
 * When the data was read, as a wall clock time — `"18:31 기준"`.
 *
 * Deliberately absolute rather than relative ("방금 기준", "5분 전 기준").
 * A relative label is computed once, when the snapshot is written, and then
 * frozen into it: a widget showing "방금 기준" is still showing "방금 기준" two
 * hours later, which is the one thing this label exists to prevent. An
 * absolute time is still true whenever it is read, however old the snapshot
 * is, and on Android — where the countdown beside it cannot tick — it is the
 * only honest thing on the widget.
 */
export function formatObservedAt(observedAtMs: number): string {
  const at = new Date(observedAtMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())} 기준`;
}

/**
 * Reads the arrival estimate, in seconds.
 *
 * The backend sends `estimatedArrivalSeconds` when it has one and falls back
 * to `arrivalEstimateTime` (the raw upstream field, sometimes a string)
 * otherwise, which is why both are tried. A row with neither is not
 * renderable and gets dropped by the caller.
 */
export function etaSecondsOf(item: BusArrivalApiItem): number | null {
  if (typeof item.estimatedArrivalSeconds === 'number' && item.estimatedArrivalSeconds >= 0) {
    return item.estimatedArrivalSeconds;
  }
  const raw = Number(item.arrivalEstimateTime);
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * Pins every item's observation time, filling a missing `observedAt` with the
 * moment of the fetch.
 *
 * Must run once, before props are built for any future moment: otherwise an
 * item without an upstream `observedAt` is re-anchored to whatever `now` each
 * timeline entry is built for, its arrival slides forward with it, and the bus
 * never arrives.
 */
export function withObservedAt(items: BusArrivalApiItem[], fetchedAt: Date): BusArrivalApiItem[] {
  return items.map((item) =>
    typeof item.observedAt === 'number' ? item : { ...item, observedAt: fetchedAt.getTime() },
  );
}

/** The instant a usable item's bus is expected, or null for a row that can't be shown. */
function arrivesAtOf(item: BusArrivalApiItem, now: Date): number | null {
  const etaSeconds = etaSecondsOf(item);
  if (etaSeconds === null || !item.routeNo?.trim()) return null;
  const observedAt = typeof item.observedAt === 'number' ? item.observedAt : now.getTime();
  return observedAt + etaSeconds * 1000;
}

/**
 * The future moments at which the widget's list itself changes: each bus
 * turning "곧 도착" ({@link ARRIVING_SOON_SECONDS} before it arrives) and each
 * bus arriving and dropping off. Handed to WidgetKit as timeline entries, so
 * the list stays truthful between fetches without any network.
 */
export function arrivalBoundariesOf(items: BusArrivalApiItem[], now: Date): Date[] {
  const instants = new Set<number>();
  for (const item of items) {
    const arrivesAt = arrivesAtOf(item, now);
    if (arrivesAt === null) continue;
    for (const at of [arrivesAt - ARRIVING_SOON_SECONDS * 1000, arrivesAt]) {
      if (at > now.getTime()) instants.add(at);
    }
  }
  return [...instants].sort((a, b) => a - b).map((at) => new Date(at));
}

/** How often a bus's last stretch is re-checked once it has turned "잠시후". */
export const ARRIVAL_POLL_SECONDS = 20;

/**
 * How long past its estimated arrival a bus keeps being re-checked. Estimates
 * lag the bus itself, so "arrived" by the clock isn't "gone" by the API; the
 * last check is what confirms the row can go and fills it with the next bus.
 */
export const ARRIVAL_GRACE_SECONDS = 30;

/**
 * The moments, epoch ms, at which the widget should fetch again: every
 * {@link ARRIVAL_POLL_SECONDS} through each on-screen bus's last stretch, from
 * when it turns "잠시후" until {@link ARRIVAL_GRACE_SECONDS} after it's due.
 *
 * One fetch at the "잠시후" flip wasn't enough. That reading usually still has
 * the bus a few seconds out, so nothing after it asked again, and the row sat
 * on "잠시후" until something else happened to refresh the widget. Polling the
 * window instead finds out when the bus has actually gone.
 *
 * "On screen" is the three earliest buses still to come when the window
 * opens, the same cut {@link toBusArrivalProps} makes — a bus further down the
 * list isn't worth a runtime boot every 20 seconds. Only moments still ahead
 * of `now` are returned. Android only: a WidgetKit entry can't fetch.
 */
export function arrivalRefreshMomentsOf(items: BusArrivalApiItem[], now: Date): Set<number> {
  const arrivals = items
    .map((item) => arrivesAtOf(item, now))
    .filter((at): at is number => at !== null);
  const moments = new Set<number>();
  for (const arrivesAt of arrivals) {
    const soonAt = arrivesAt - ARRIVING_SOON_SECONDS * 1000;
    const windowOpensAt = Math.max(soonAt, now.getTime());
    const ahead = arrivals.filter((other) => other > windowOpensAt && other < arrivesAt).length;
    if (ahead >= 3) continue;
    for (let at = soonAt; at <= arrivesAt + ARRIVAL_GRACE_SECONDS * 1000; at += ARRIVAL_POLL_SECONDS * 1000) {
      if (at > now.getTime()) moments.add(at);
    }
  }
  return moments;
}

/**
 * Turns an arrivals response into the widget's snapshot *as of `now`*.
 *
 * `now` is the moment being rendered, which for a timeline entry is in the
 * future: buses that have arrived by then are dropped, and "곧 도착" and the
 * formatted estimate are worked out against it. Estimates stay anchored to the
 * upstream `observedAt` (preferred over `now`, since the estimate is relative
 * to when the transit API read it) — see {@link withObservedAt}.
 */
export function toBusArrivalProps(
  items: BusArrivalApiItem[],
  stopLabel: string,
  now: Date,
): BusArrivalWidgetProps {
  const arrivals = items
    .map((item) => {
      const arrivesAt = arrivesAtOf(item, now);
      const route = item.routeNo?.trim();
      if (arrivesAt === null || !route) return null;

      const remainingSeconds = Math.round((arrivesAt - now.getTime()) / 1000);
      // Arrived by `now`: not a row any more. Leaving it in is what showed a
      // timer counting back up from zero the morning after.
      if (remainingSeconds <= 0) return null;

      const observedAt = typeof item.observedAt === 'number' ? item.observedAt : now.getTime();
      return {
        route,
        eta: formatEta(remainingSeconds),
        soon: remainingSeconds <= ARRIVING_SOON_SECONDS,
        // Absolute instant, not a duration — see this module's doc comment.
        arrivesAt,
        observedLabel: formatObservedAt(observedAt),
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .sort((a, b) => a.arrivesAt - b.arrivesAt)
    // Three rows is what the Figma frame has room for.
    .slice(0, 3);

  if (arrivals.length === 0) return { status: 'noData' };
  return { status: 'normal', stopLabel, arrivals };
}

// --- Which stop -----------------------------------------------------------

/** Subset of `/api/buses/routes` — see inu-portal-web's `useDynamicBusRoutes`. */
type BusRouteApiItem = {
  routeId?: string;
  startBstopId?: string;
  startBstopName?: string;
  startBstopAlias?: string;
  stops?: { bstopId?: string; latitude?: number; longitude?: number }[];
};

type StopAlias = { bstopId?: string; stopAlias?: string; bstopName?: string };

/** A stop the portal lists buses for, with where it is. */
export type BusStop = {
  bstopId: string;
  /** Short display name ("2번출구", "정문(길 건너)") — the widget's header label. */
  label: string;
  latitude: number;
  longitude: number;
  /** Routes the portal shows at this stop; arrivals for any other route are noise. */
  routeIds: string[];
};

/** The portal's own sanity range for WGS84 in Korea (`normalizeCoordinate`). */
function isKoreanWgs84(latitude?: number, longitude?: number): boolean {
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    latitude >= 33 &&
    latitude <= 39 &&
    longitude >= 124 &&
    longitude <= 132
  );
}

/**
 * The portal's stops, derived from its routes.
 *
 * Mirrors the web's home bus card: a stop is a route's *starting* stop, and its
 * buses are the routes starting there. Stop aliases carry the nicer name but no
 * coordinates, so the position comes from the route's own stop list. Both the
 * go-school and go-home routes count — "nearest" is about where the user is,
 * not what time it is.
 */
export function busStopsOf(routes: BusRouteApiItem[], aliases: StopAlias[]): BusStop[] {
  const stops = new Map<string, BusStop>();
  for (const route of routes) {
    const bstopId = route.startBstopId?.trim();
    if (!bstopId) continue;

    const existing = stops.get(bstopId);
    if (existing) {
      if (route.routeId && !existing.routeIds.includes(route.routeId)) {
        existing.routeIds.push(route.routeId);
      }
      continue;
    }

    const start = route.stops?.find((s) => s.bstopId === bstopId) ?? route.stops?.[0];
    if (!start || !isKoreanWgs84(start.latitude, start.longitude)) continue;

    const alias = aliases.find((a) => a.bstopId === bstopId);
    stops.set(bstopId, {
      bstopId,
      label:
        alias?.stopAlias?.trim() ||
        route.startBstopAlias?.trim() ||
        route.startBstopName?.trim() ||
        '정류장',
      latitude: start.latitude!,
      longitude: start.longitude!,
      routeIds: route.routeId ? [route.routeId] : [],
    });
  }
  return [...stops.values()];
}

/** Great-circle distance in meters. */
export function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * The stop closest to `position`, or the portal's first stop when there is no
 * position to go by (location off, never granted) — a default that is at least
 * the stop most riders start from.
 */
export function nearestStop(
  stops: BusStop[],
  position: { latitude: number; longitude: number } | null,
): BusStop | null {
  if (stops.length === 0) return null;
  if (!position) return stops[0];
  return stops.reduce((best, stop) =>
    distanceMeters(position, stop) < distanceMeters(position, best) ? stop : best,
  );
}

/** Keeps only the arrivals for routes shown at the stop. An empty list means "don't filter". */
export function arrivalsForStop(items: BusArrivalApiItem[], stop: BusStop): BusArrivalApiItem[] {
  if (stop.routeIds.length === 0) return items;
  return items.filter((item) => item.routeId !== undefined && stop.routeIds.includes(item.routeId));
}

/**
 * Every stop the portal lists buses for, or null when the routes couldn't be
 * read. Aliases only improve the labels, so their failure isn't fatal.
 */
export async function fetchBusStops(): Promise<BusStop[] | null> {
  const [goSchool, goHome, aliases] = await Promise.all([
    getJson<BusRouteApiItem[]>('/api/buses/routes', { query: { category: 'go-school' } }),
    getJson<BusRouteApiItem[]>('/api/buses/routes', { query: { category: 'go-home' } }),
    getJson<StopAlias[]>('/api/buses/stop-aliases'),
  ]);
  if (goSchool === null && goHome === null) return null;
  return busStopsOf([...(goSchool ?? []), ...(goHome ?? [])], aliases ?? []);
}

/** Arrivals for one stop, or null if the request failed. */
export async function fetchBusArrivals(bstopId: string): Promise<BusArrivalApiItem[] | null> {
  return getJson<BusArrivalApiItem[]>('/api/buses/arrivals', { query: { bstopId } });
}
