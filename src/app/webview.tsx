/**
 * A pushed sub-page in the native multi-WebView stack (spec §3). Reached when
 * the web calls `navigateTo(path, url)` from a non-main-tab destination; the
 * native stack gives it the slide-in animation and swipe-back gesture.
 */
import { useEffect } from 'react';
import { Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import WebViewContainer from '../components/WebViewContainer';
import { PORTAL_HOST } from '../webview/constants';

/** True when `url` points at the portal host and is therefore safe to host. */
function isPortalUrl(url: string): boolean {
  try {
    return new URL(url).host === PORTAL_HOST;
  } catch {
    return false;
  }
}

export default function WebViewScreen() {
  const router = useRouter();
  const { url } = useLocalSearchParams<{ url?: string; path?: string }>();
  const target = typeof url === 'string' ? url : '';
  const valid = isPortalUrl(target);

  // Defence in depth: navigateTo should only ever pass portal URLs, but if an
  // off-portal URL slips through, hand it to the system browser and pop back.
  useEffect(() => {
    if (!valid) {
      if (target) Linking.openURL(target).catch(() => {});
      if (router.canGoBack()) router.back();
    }
  }, [router, target, valid]);

  if (!valid) return null;
  return <WebViewContainer mode="sub" url={target} />;
}
