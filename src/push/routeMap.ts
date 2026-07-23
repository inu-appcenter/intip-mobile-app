/**
 * `type` -> in-portal path builder (spec G3 step 1). The web team hasn't
 * confirmed dedicated in-app routes for any notification `type` yet (e.g. a
 * `FRIEND` detail page, an in-app notice viewer for `SCHOOL_NOTICE`), so this
 * table is intentionally empty: every payload falls through to `data.path`
 * (see `resolveNavIntent` in `navIntent.ts`, step 2). Once a route is
 * confirmed, add an entry here — the rest of the pipeline needs no changes.
 *
 * Kept dependency-free (same reasoning as `navPath.ts`) so it stays
 * unit-testable without Firebase/notifee.
 */

/** Server-defined notification `type` (`data.type`, always a string over FCM). */
export type NotificationType = 'GENERAL' | 'CHAT' | 'SCHOOL_NOTICE' | 'DEPARTMENT' | 'FRIEND';

/**
 * Given the full `data` payload (so a builder can read e.g. `targetId` /
 * `noticeId` / `chatRoomId`), return the in-portal path for that `type`, or
 * `undefined` to fall through to `data.path`.
 */
type RouteBuilder = (data: Record<string, unknown>) => string | undefined;

/**
 * Empty until the web team confirms routes. Example of what an entry would
 * look like once `FRIEND`'s detail path is confirmed:
 *   FRIEND: (data) =>
 *     typeof data.targetId === 'string' ? `/friend/${data.targetId}` : undefined,
 */
const ROUTE_MAP: Partial<Record<NotificationType, RouteBuilder>> = {};

/** Map a notification's `type` to a portal path via `ROUTE_MAP`, if present. */
export function routeForType(data?: Record<string, unknown>): string | null {
  if (!data) return null;
  const { type } = data;
  if (typeof type !== 'string') return null;
  const builder = ROUTE_MAP[type as NotificationType];
  if (!builder) return null;
  return builder(data) ?? null;
}
