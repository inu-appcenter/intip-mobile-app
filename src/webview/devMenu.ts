/**
 * Registers the INTIP WebView controller into the Expo developer menu
 * (shake / three-finger long-press) via `expo-dev-menu`'s `registerDevMenuItems`.
 *
 * The menu items are thin entry points: the headline item opens the in-app
 * controller panel, the rest are quick read-outs / session actions surfaced as
 * native alerts so they work even without opening the panel. Everything is
 * guarded behind `__DEV__` — the dev menu only exists in debug builds.
 *
 * `registerDevMenuItems` replaces all previously registered items on each call
 * (per the Expo docs), so this is registered exactly once by the provider.
 */
import { Alert } from 'react-native';
import { registerDevMenuItems } from 'expo-dev-menu';

import {
  formatSession,
  formatSnapshotSummary,
  formatStack,
  formatWhereAmI,
} from './controllerFormat';
import type { WebViewController } from './WebViewContext';

/** Late-bound accessor so callbacks always read the freshest controller. */
type GetController = () => WebViewController;

async function saveAndReport(controller: WebViewController): Promise<void> {
  try {
    const snapshot = await controller.saveSession();
    Alert.alert('Session saved', formatSnapshotSummary(snapshot.savedAt, snapshot.stack));
  } catch {
    Alert.alert('Save failed', 'Could not write the dev session to disk.');
  }
}

async function loadAndRestore(controller: WebViewController): Promise<void> {
  const snapshot = await controller.loadSession();
  if (!snapshot) {
    Alert.alert('No saved session', 'Save one first from the dev menu or controller panel.');
    return;
  }
  Alert.alert('Restore session?', formatSnapshotSummary(snapshot.savedAt, snapshot.stack), [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Restore', onPress: () => void controller.restoreSession(snapshot) },
  ]);
}

export function registerWebViewDevMenu(getController: GetController): void {
  if (!__DEV__) return;
  try {
    void registerDevMenuItems([
      {
        name: '🎛️ WebView Controller',
        callback: () => getController().togglePanel(),
      },
      {
        name: '🧭 Where am I?',
        callback: () => {
          const c = getController();
          Alert.alert('Where am I?', formatWhereAmI(c.getActive(), c.stack.length));
        },
      },
      {
        name: '🗂️ Navigation stack',
        callback: () => {
          const c = getController();
          Alert.alert(`Navigation stack (${c.stack.length})`, formatStack(c.stack));
        },
      },
      {
        name: '🔐 Session status',
        callback: () => Alert.alert('Session', formatSession(getController().session)),
      },
      {
        name: '💾 Save WebView session',
        callback: () => void saveAndReport(getController()),
      },
      {
        name: '📂 Load WebView session',
        callback: () => void loadAndRestore(getController()),
      },
    ]);
  } catch (err) {
    console.warn('[devmenu] WebView controller registration skipped', err);
  }
}
