import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Platform,
  StyleSheet,
  useColorScheme,
  View,
} from 'react-native';

import { nativeAlert } from '../../modules/intip-native-dialog';
import WebViewContainer from '../components/WebViewContainer';
import { isConnected } from '../native/network';
import { ROOT_URL, STRINGS } from '../webview/constants';
import { backgroundColorFor } from '../theme';

type GateStatus = 'checking' | 'offline' | 'online';

/**
 * Launch gate: check connectivity before rendering the portal (Swift ref:
 * `ContentView.checkNetwork()`). Once online, the root WebView container mounts
 * and stays mounted for the app's lifetime; sub-pages are pushed on top as
 * native-stack screens (`app/webview.tsx`). Push-notification routing, the
 * launch overlay, and the dev-controller navigator all live in the root
 * container.
 */
export default function Index() {
  const scheme = useColorScheme();
  const backgroundColor = backgroundColorFor(scheme);

  const [status, setStatus] = useState<GateStatus>('checking');

  // React Compiler is enabled (app.json), so this stays a plain function — no
  // manual useCallback, which avoids the check/alert circular-memoization warning.
  const check = async () => {
    setStatus('checking');
    if (await isConnected()) {
      setStatus('online');
      return;
    }
    setStatus('offline');
    nativeAlert(STRINGS.network.title, STRINGS.network.message, [
      { text: STRINGS.network.retry, onPress: () => void check() },
      Platform.OS === 'ios'
        ? { text: STRINGS.network.exit, style: 'destructive' }
        : { text: STRINGS.network.close, style: 'cancel', onPress: () => BackHandler.exitApp() },
    ]);
  };

  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === 'online') {
    return <WebViewContainer mode="root" url={ROOT_URL} />;
  }

  // Checking / offline: a plain branded background (no WebView yet).
  return (
    <View style={[styles.center, { backgroundColor }]}>
      {status === 'checking' && <ActivityIndicator />}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
