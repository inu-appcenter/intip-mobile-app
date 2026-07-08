import { StyleSheet, useColorScheme, View } from 'react-native';

import { backgroundColorFor } from '../theme';

/**
 * Launch background. The real portal (root WebView), the connectivity gate, and
 * the custom sub-page stack are all owned by `<WebViewHost/>` (rendered above
 * this screen in `_layout.tsx`), so this route only paints the branded
 * background that sits behind the host while it boots.
 */
export default function Index() {
  const scheme = useColorScheme();
  const backgroundColor = backgroundColorFor(scheme);
  return <View style={[styles.fill, { backgroundColor }]} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
