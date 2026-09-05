/**
 * Maps a notification's data payload to what the app should do about it: SPA
 * route on the always-mounted root, native sub-page push, or hand off to a
 * browser. Kept dependency-free (same reasoning as `navPath.ts`) so it is
 * unit-testable without Firebase/notifee.
 */
import { PUSH_EXTERNAL_HOSTS, isMainTabPath, portalUrlFor } from '../webview/constants';
import { extractCandidate, extractNavPath } from './navPath';
import { routeForType } from './routeMap';

export type NavIntent = (
  // Main-tab destination: drive the root instance's own SPA (`goHome`).
  | { kind: 'spa'; path: string }
  // Non-main-tab destination: push a native sub-page instance (`pushSub`).
  // `url` is a fully-qualified portal URL (see `portalUrlFor`) — `pushSub`
  // requires one, it doesn't accept a bare path.
  | { kind: 'push'; path: string; url: string }
  // Off-portal, allow-listed host: hand off to the in-app browser.
  | { kind: 'external'; url: string }
) & {
  /** Present only for a push-notification tap; share/deep-link intents omit it. */
  fcmMessageId?: number;
  notificationType?: string;
  campaignId?: string;
  sentAt?: string;
};

/**
 * FCM data values arrive as strings. Convert only a positive safe integer so
 * malformed payloads can never turn into a request for the wrong notification.
 */
export function extractFcmMessageId(data?: Record<string, unknown>): number | undefined {
  const value = data?.fcmMessageId;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function extractOptionalString(
  data: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = data?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function withFcmMessageId(intent: NavIntent, data?: Record<string, unknown>): NavIntent {
  const fcmMessageId = extractFcmMessageId(data);
  const notificationType = extractOptionalString(data, "notificationType");
  const campaignId = extractOptionalString(data, "campaignId");
  const sentAt = extractOptionalString(data, "sentAt");

  if (
    fcmMessageId === undefined &&
    notificationType === undefined &&
    campaignId === undefined &&
    sentAt === undefined
  ) {
    return intent;
  }

  const metadata: Pick<NavIntent, "notificationType" | "campaignId" | "sentAt"> = {};
  if (notificationType !== undefined) metadata.notificationType = notificationType;
  if (campaignId !== undefined) metadata.campaignId = campaignId;
  if (sentAt !== undefined) metadata.sentAt = sentAt;

  return {
    ...intent,
    ...metadata,
    ...(fcmMessageId === undefined ? {} : { fcmMessageId }),
  };
}

/** True when `host` is (or is a subdomain of) one of the allow-listed domains. */
function isAllowedExternalHost(host: string): boolean {
  return (PUSH_EXTERNAL_HOSTS as readonly string[]).some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

/**
 * Build the spa/push intent for an in-portal `path`. `path` must be the
 * *original* candidate (query string intact) — `isMainTabPath` normalizes its
 * own copy internally for the main-tab check only, it never truncates the
 * value we hand back.
 *
 * Exported because deep links (`src/links/deepLink.ts`) land on the same
 * decision: a portal path is either a main tab the root WebView routes to
 * itself, or a sub-page that gets its own native screen. Both entry points
 * must answer that question identically, so they share this one function
 * rather than each reimplementing the `isMainTabPath` branch.
 */
export function intentForPortalPath(path: string): NavIntent {
  if (isMainTabPath(path)) return { kind: 'spa', path };
  return { kind: 'push', path, url: portalUrlFor(path) };
}

/**
 * Map a notification's data payload to a nav intent, if any. Order:
 *  1. `routeMap`'s `type` -> path mapping, if present.
 *  2. Else `data.path` (falls back to `route`/`link`/`url` for compat).
 *  3. A `/`-prefixed candidate is an in-portal path as-is.
 *  4. An absolute URL on the portal host is converted to `pathname + search`.
 *  (3) and (4) both then branch spa/push via `isMainTabPath`.
 *  5. Any other http(s) URL is checked against the G1 off-portal allowlist.
 *  6. Anything else resolves to `null`.
 */
export function resolveNavIntent(data?: Record<string, unknown>): NavIntent | null {
  const mappedPath = routeForType(data);
  const portalPath = mappedPath ?? extractNavPath(data);
  if (portalPath) return withFcmMessageId(intentForPortalPath(portalPath), data);

  const candidate = extractCandidate(data);
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    if (/^https?:$/.test(u.protocol) && isAllowedExternalHost(u.host)) {
      return withFcmMessageId({ kind: 'external', url: candidate }, data);
    }
  } catch {
    /* not a URL */
  }
  return null;
}
