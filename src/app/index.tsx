import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Platform,
  StyleSheet,
  useColorScheme,
  View,
} from 'react-native';

import WebViewContainer from '../components/WebViewContainer';
import { isConnected } from '../native/network';
import { getInitialNavPath } from '../push/messaging';
import { ROOT_URL, STRINGS } from '../webview/constants';
import { backgroundColorFor } from '../theme';

type GateStatus = 'checking' | 'offline' | 'online';

/**
 * Launch gate: check connectivity before rendering the portal.
 * Swift ref: `ContentView.checkNetwork()`. The WebView is not mounted until the
 * device is connected.
 */
export default function Index() {
  const scheme = useColorScheme();
  const backgroundColor = backgroundColorFor(scheme);

  const [status, setStatus] = useState<GateStatus>('checking');
  const [initialNavPath, setInitialNavPath] = useState<string | null>(null);

  // React Compiler is enabled (app.json), so these stay plain functions — no
  // manual useCallback, which avoids the check/alert circular-memoization warning.
  const check = async () => {
    setStatus('checking');
    const connected = await isConnected();
    if (connected) {
      setStatus('online');
      return;
    }
    setStatus('offline');
    Alert.alert(STRINGS.network.title, STRINGS.network.message, [
      { text: STRINGS.network.retry, onPress: () => void check() },
      Platform.OS === 'ios'
        ? { text: STRINGS.network.exit, style: 'destructive' }
        : { text: STRINGS.network.close, style: 'cancel', onPress: () => BackHandler.exitApp() },
    ]);
  };

  useEffect(() => {
    // Resolve a deep-link if a notification cold-started the app, then gate on
    // connectivity. Runs once on mount.
    void getInitialNavPath().then(setInitialNavPath);
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === 'online') {
    return <WebViewContainer mode="root" url={ROOT_URL} initialNavPath={initialNavPath} />;
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
