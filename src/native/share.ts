/**
 * Outgoing OS Share Sheet (bridge `share` / `shareResult`).
 *
 * Web calls `channel.requestWithOptions("share", { timeoutMs }, payload)` and
 * expects a `shareResult` reply on the same id (`checkBack`/`backResult`'s
 * request/reply pattern — see `WebViewContainer`'s "Bridge: Web -> Native"
 * effect). This module only builds the result; the wiring/reply lives there.
 *
 * This is the OUTGOING direction (native shares content the web asked it to
 * share). `src/share/gradeShareIntent.ts` is the OPPOSITE direction — an
 * INCOMING Android share intent handed to the app from another app's share
 * sheet. Kept in `src/native/` rather than `src/share/` because it wraps a
 * plain OS API call (same shape as `downloads.ts`, `permissions.ts`) with no
 * portal-routing logic, whereas `src/share/` is for resolving an incoming
 * share into an in-app navigation intent.
 *
 * v1 uses only React Native's built-in `Share` API — no new dependency.
 * `payload.files` (image/file sharing) is out of scope for v1 and always
 * answers `unsupported`; phase 2 would add `expo-sharing` (caching the
 * remote/data-uri file to a local path first, since `expo-sharing` needs a
 * local file URI) and advertise it as a separate `share:files` feature in
 * `bridgeCapabilities` rather than folding it into `share`.
 */
import { Platform, Share } from 'react-native';
import type { SharePayload, ShareResultPayload } from '../../packages/intip-bridge/src/messages';

/** Join non-empty parts with a newline, dropping blanks. */
function joinNonEmpty(parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => !!part && part.length > 0).join('\n');
}

/**
 * Share `payload` via the OS share sheet. Never rejects — every failure path
 * (unsupported files, nothing shareable, thrown error) resolves to a
 * `ShareResultPayload` so the caller can always `channel.reply(msg,
 * "shareResult", result)`.
 */
export async function shareContent(payload: SharePayload): Promise<ShareResultPayload> {
  // File/image sharing is planned phase 2 (expo-sharing + local caching) and
  // would be advertised as its own "share:files" feature — v1 always bails
  // out here rather than silently dropping the files.
  if (payload.files && payload.files.length > 0) {
    return {
      status: 'unsupported',
      message: 'File/image sharing is not supported in this app version.',
    };
  }

  try {
    if (Platform.OS === 'android') {
      // Share.share on Android ignores `url` entirely — fold it into the
      // message so a shared link still comes through.
      const message = joinNonEmpty([payload.text, payload.url]);
      if (!message) {
        return { status: 'error', message: 'Nothing to share.' };
      }
      const result = await Share.share(
        { title: payload.title, message },
        { dialogTitle: payload.dialogTitle },
      );
      return mapResult(result);
    }

    // iOS: `message` and `url` are separate fields — passing them separately
    // (rather than concatenating) is what gives the rich link preview in the
    // activity sheet.
    if (!payload.text && !payload.url) {
      return { status: 'error', message: 'Nothing to share.' };
    }
    const result = await Share.share(
      { title: payload.title, message: payload.text, url: payload.url } as Parameters<
        typeof Share.share
      >[0],
      { dialogTitle: payload.dialogTitle },
    );
    return mapResult(result);
  } catch (error) {
    return { status: 'error', message: String(error) };
  }
}

function mapResult(result: { action: string; activityType?: string | null }): ShareResultPayload {
  if (result.action === Share.dismissedAction) {
    return { status: 'dismissed' };
  }
  // Share.sharedAction (Android always resolves this way; iOS on success).
  return {
    status: 'shared',
    ...(typeof result.activityType === 'string' && result.activityType.length > 0
      ? { activityType: result.activityType }
      : {}),
  };
}
