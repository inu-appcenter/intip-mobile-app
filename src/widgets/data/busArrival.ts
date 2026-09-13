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
  routeNo?: string;
  arrivalEstimateTime?: string | number;
  estimatedArrivalSeconds?: number;
  estimationNotice?: string;
  observedAt?: number;
  lastBusYn?: string;
};

/**
 * Under this many seconds the design says "곧 도착" instead of a countdown —
 * a number that small has more error than signal, and it is what the rider
 * actually needs to know.
 */
export const ARRIVING_SOON_SECONDS = 60;

/** Seconds → `"4분 19초"`, or `"곧 도착"` when it is close enough. */
export function formatEta(seconds: number): string {
  if (seconds <= ARRIVING_SOON_SECONDS) return '곧 도착';
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
 * Turns an arrivals response into the widget's snapshot.
 *
 * `now` is both the clock and the fallback observation time: the upstream
 * `observedAt` is preferred when present, since the estimate is relative to
 * when the transit API read it, not to when we happened to ask.
 */
export function toBusArrivalProps(
  items: BusArrivalApiItem[],
  exitLabel: string,
  now: Date,
): BusArrivalWidgetProps {
  const arrivals = items
    .map((item) => {
      const etaSeconds = etaSecondsOf(item);
      const route = item.routeNo?.trim();
      if (etaSeconds === null || !route) return null;

      const observedAt = typeof item.observedAt === 'number' ? item.observedAt : now.getTime();
      return {
        route,
        eta: formatEta(etaSeconds),
        soon: etaSeconds <= ARRIVING_SOON_SECONDS,
        // Absolute instant, not a duration — see this module's doc comment.
        // Anchored to `observedAt` so a snapshot that took a while to reach
        // the widget still counts down to the right moment.
        arrivesAt: observedAt + etaSeconds * 1000,
        observedLabel: formatObservedAt(observedAt),
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .sort((a, b) => a.arrivesAt - b.arrivesAt)
    // Three rows is what the Figma frame has room for.
    .slice(0, 3);

  if (arrivals.length === 0) return { status: 'noData' };
  return { status: 'normal', exitLabel, arrivals };
}

type StopAlias = { bstopId?: string | number; stopName?: string };

/**
 * The stop the widget shows arrivals for.
 *
 * The portal lets a user pick among stops on the home screen; the widget has
 * no such affordance and no access to that choice, so it takes the first stop
 * the backend lists. That is a real simplification, not a finished feature —
 * when a per-user preference exists, this is the one place to read it from.
 *
 * Returns null when the list is unavailable or has no usable entry, which the
 * caller renders as the widget's `noData` state rather than guessing an id.
 */
export async function fetchDefaultStop(): Promise<{ bstopId: string; stopName: string } | null> {
  const aliases = await getJson<StopAlias[]>('/api/buses/stop-aliases');
  const first = (aliases ?? []).find((a) => a.bstopId !== undefined && a.bstopId !== null);
  if (!first) return null;
  return {
    bstopId: String(first.bstopId),
    stopName: first.stopName?.trim() || '정류장',
  };
}

/** Arrivals for one stop, or null if the request failed. */
export async function fetchBusArrivals(bstopId: string): Promise<BusArrivalApiItem[] | null> {
  return getJson<BusArrivalApiItem[]>('/api/buses/arrivals', { query: { bstopId } });
}
