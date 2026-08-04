/**
 * Disk persistence for a dev WebView session snapshot. Stored as a single JSON
 * file in the app document directory via react-native-blob-util (already used
 * by the downloads helper), so no new dependency is needed.
 *
 * This is a developer/debug convenience only — it is never read on a normal
 * launch; the controller GUI and dev menu drive save/load explicitly.
 */
import ReactNativeBlobUtil from 'react-native-blob-util';

import {
  parseSnapshot,
  serializeSnapshot,
  type SessionSnapshot,
  type SessionState,
  type SnapshotEntry,
} from './sessionSnapshot';

// Lazy, not a module-level const: `expo export` (which `eas update` runs to
// build the OTA bundle) statically evaluates every route module — including
// this one, via `_layout.tsx` -> `WebViewControllerPanel` -> `WebViewContext`
// -> here — in a server/Node pass that has no native modules loaded. Reading
// `ReactNativeBlobUtil.fs.dirs` eagerly at import time threw there
// ("Cannot read properties of undefined (reading 'dirs')") and failed the
// whole export. None of these functions run during that pass — only a live
// dev-controller action calls them — so deferring the read to call time is
// enough to dodge it.
function filePath(): string {
  return `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/intip-devsession.json`;
}

/** Serialize the live stack + session and write it to disk. */
export async function writeSnapshot(
  stack: readonly SnapshotEntry[],
  session: SessionState,
): Promise<SessionSnapshot> {
  const snapshot = serializeSnapshot(stack, session);
  await ReactNativeBlobUtil.fs.writeFile(filePath(), JSON.stringify(snapshot), 'utf8');
  return snapshot;
}

/** Read the saved snapshot, or `null` if none exists / it is unreadable. */
export async function readSnapshot(): Promise<SessionSnapshot | null> {
  try {
    const exists = await ReactNativeBlobUtil.fs.exists(filePath());
    if (!exists) return null;
    const raw = await ReactNativeBlobUtil.fs.readFile(filePath(), 'utf8');
    return parseSnapshot(typeof raw === 'string' ? raw : String(raw));
  } catch (err) {
    console.warn('[devsession] read failed', err);
    return null;
  }
}

/** Delete the saved snapshot, if present. */
export async function clearSnapshot(): Promise<void> {
  try {
    if (await ReactNativeBlobUtil.fs.exists(filePath())) {
      await ReactNativeBlobUtil.fs.unlink(filePath());
    }
  } catch (err) {
    console.warn('[devsession] clear failed', err);
  }
}
