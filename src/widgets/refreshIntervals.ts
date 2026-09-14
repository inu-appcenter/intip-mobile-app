/**
 * How stale each Android widget's data may get before drawing it also fetches
 * new data (see `headless.ts` and expo-widgets-glance's `WidgetRefreshTask`).
 *
 * These are floors, not schedules. Nothing here makes Android draw a widget —
 * the launcher decides that — so a value only ever means "if you were going to
 * repaint anyway, and it's been this long, also go fetch." Every fetch costs a
 * JS runtime boot in a process that may be starting cold, which is why none of
 * these are as short as the data could theoretically justify.
 *
 * iOS uses none of this: its widgets are given the day's timeline up front.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * The timetable only changes when the user edits it — and when they do, the
 * app is open and pushes the change immediately. This exists to catch an edit
 * made on the web, and to roll the day over on a device the app hasn't been
 * opened on, so once every few hours is more than enough.
 */
export const SCHEDULE_REFRESH_MS = 6 * HOUR;

/**
 * The menu for a given day is fixed; only which meal is current moves, and
 * those boundaries are known in advance. Twice a day covers a menu that was
 * published late.
 */
export const CAFETERIA_REFRESH_MS = 6 * HOUR;

/**
 * The only widget whose data is genuinely perishable. Ten minutes is a
 * compromise, not a target: shorter would mean a runtime boot on nearly every
 * repaint for an estimate that is stale again within a minute regardless. The
 * widget shows how old its reading is for exactly this reason — see
 * `data/busArrival.ts`.
 */
export const BUS_REFRESH_MS = 10 * MINUTE;

/**
 * How often the bus widget is refreshed while the app is open and in the
 * foreground — the same 30 seconds inu-portal-web's `useBusArrival` polls at.
 *
 * Unlike every value above, this one is a real schedule: the app is running,
 * so it can simply fetch on a timer. It is also cheap on iOS, where timeline
 * reloads requested by a foreground app don't count against WidgetKit's daily
 * budget. It stops the moment the app leaves the foreground.
 */
export const BUS_FOREGROUND_POLL_MS = 30 * 1000;
