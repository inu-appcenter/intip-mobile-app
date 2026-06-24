/**
 * Pure (no-native) serialization for the dev WebView "session" — a snapshot of
 * the live multi-WebView stack plus the login/session state. Kept free of any
 * React-Native imports so it can be unit-tested and reused by both the
 * persistence layer (`sessionStore.ts`) and the controller GUI.
 *
 * A "session" here is a developer convenience: it records which portal pages are
 * open in the native stack (and where each one currently sits) so the stack can
 * be inspected, saved, and restored from the dev menu / controller panel.
 */

export type WebViewMode = 'root' | 'sub';

/** Login/session state shared across every WebView in the app. */
export type SessionState = {
  /** True once the web reported `loginSuccess` (tokenInfo present). */
  loggedIn: boolean;
  /** When login was last observed (epoch ms), or null if never. */
  loginAt: number | null;
  /** Most recent FCM token pushed into the web context, if any. */
  fcmToken: string | null;
};

/** One open container, reduced to the fields worth persisting. */
export type SnapshotEntry = {
  mode: WebViewMode;
  url: string;
  path: string;
};

/** A saved/loadable dev session. Schema is versioned for forward safety. */
export type SessionSnapshot = {
  version: 1;
  savedAt: number;
  session: SessionState;
  stack: SnapshotEntry[];
};

export const SNAPSHOT_VERSION = 1 as const;

export const EMPTY_SESSION: SessionState = {
  loggedIn: false,
  loginAt: null,
  fcmToken: null,
};

/** Anything carrying enough fields to be reduced to a {@link SnapshotEntry}. */
type EntryLike = { mode: WebViewMode; url: string; path: string };

/** Build a snapshot from the live stack + session. `now` is injectable for tests. */
export function serializeSnapshot(
  stack: readonly EntryLike[],
  session: SessionState,
  now: number = Date.now(),
): SessionSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    savedAt: now,
    session: { ...session },
    stack: stack.map((e) => ({ mode: e.mode, url: e.url, path: e.path })),
  };
}

function isMode(value: unknown): value is WebViewMode {
  return value === 'root' || value === 'sub';
}

function parseEntry(value: unknown): SnapshotEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const { mode, url, path } = value as Record<string, unknown>;
  if (!isMode(mode)) return null;
  if (typeof url !== 'string' || url.length === 0) return null;
  return { mode, url, path: typeof path === 'string' ? path : '' };
}

function parseSession(value: unknown): SessionState {
  if (typeof value !== 'object' || value === null) return { ...EMPTY_SESSION };
  const { loggedIn, loginAt, fcmToken } = value as Record<string, unknown>;
  return {
    loggedIn: loggedIn === true,
    loginAt: typeof loginAt === 'number' ? loginAt : null,
    fcmToken: typeof fcmToken === 'string' ? fcmToken : null,
  };
}

/**
 * Parse a previously stored snapshot. Returns `null` for anything that isn't a
 * recognisable snapshot so a corrupt/old file is treated as "no saved session".
 */
export function parseSnapshot(raw: string): SessionSnapshot | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const { version, savedAt, session, stack } = data as Record<string, unknown>;
  if (version !== SNAPSHOT_VERSION) return null;
  if (!Array.isArray(stack)) return null;

  const entries: SnapshotEntry[] = [];
  for (const item of stack) {
    const entry = parseEntry(item);
    if (entry) entries.push(entry);
  }

  return {
    version: SNAPSHOT_VERSION,
    savedAt: typeof savedAt === 'number' ? savedAt : 0,
    session: parseSession(session),
    stack: entries,
  };
}
