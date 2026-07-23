/**
 * In-app GUI for the WebView controller — the visual counterpart to the dev-menu
 * items. Toggled from the dev menu ("🎛️ WebView Controller") and rendered as a
 * draggable-free bottom sheet over the portal. Debug builds only.
 *
 * It reads the live orchestrator state from {@link useWebViewController} and lets
 * a developer see where they are, inspect the native navigation stack + session,
 * drive the active WebView (reload / back / navigate / refresh FCM), and
 * save/load the dev session.
 */
import { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatSession, formatWhereAmI, shortUrl } from '../webview/controllerFormat';
import { useWebViewController } from '../webview/WebViewContext';

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export default function WebViewControllerPanel() {
  const controller = useWebViewController();
  const [navInput, setNavInput] = useState('');
  const [note, setNote] = useState<string | null>(null);

  // Debug-only surface; never ship in a release bundle.
  if (!__DEV__ || !controller.panelVisible) return null;

  const active = controller.getActive();

  const flash = (message: string) => setNote(message);

  const onSave = async () => {
    const snapshot = await controller.saveSession();
    flash(`Saved ${snapshot.stack.length} page(s).`);
  };

  const onLoad = async () => {
    const snapshot = await controller.loadSession();
    if (!snapshot) {
      flash('No saved session.');
      return;
    }
    await controller.restoreSession(snapshot);
    flash(`Restoring ${snapshot.stack.length} page(s)…`);
  };

  const onNavigate = () => {
    const path = navInput.trim();
    if (!path) return;
    controller.navigateActive(path.startsWith('/') ? path : `/${path}`);
    setNavInput('');
    flash(`Navigated active WebView.`);
  };

  return (
    <SafeAreaView style={styles.overlay} edges={['bottom']} pointerEvents="box-none">
      {/* Tap the dimmed area to dismiss. */}
      <Pressable style={styles.backdrop} onPress={controller.hidePanel} />

      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.title}>WebView Controller</Text>
          <Pressable onPress={controller.hidePanel} hitSlop={12}>
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          <Section title="Where am I">
            <Text style={styles.mono}>{formatWhereAmI(active, controller.stack.length)}</Text>
          </Section>

          <Section title="Session">
            <Text style={styles.mono}>{formatSession(controller.session)}</Text>
          </Section>

          <Section title={`Navigation stack (${controller.stack.length})`}>
            {controller.stack.length === 0 ? (
              <Text style={styles.mono}>(empty)</Text>
            ) : (
              controller.stack.map((entry, index) => {
                const isActive = index === controller.stack.length - 1;
                return (
                  <View key={entry.id} style={styles.stackRow}>
                    <Text style={[styles.stackIndex, isActive && styles.stackIndexActive]}>
                      {isActive ? '▶' : index}
                    </Text>
                    <View style={styles.stackInfo}>
                      <Text style={styles.stackPath}>
                        [{entry.mode}] {entry.path || '/'}
                      </Text>
                      <Text style={styles.stackUrl} numberOfLines={1}>
                        {shortUrl(entry.url)}
                      </Text>
                    </View>
                  </View>
                );
              })
            )}
          </Section>

          <Section title="Controls">
            <View style={styles.row}>
              <Button label="Reload" onPress={() => controller.reloadActive()} />
              <Button label="Clear+Reload" onPress={() => controller.reloadActive(true)} />
              <Button label="Back" onPress={controller.goBackActive} />
            </View>
            <View style={styles.row}>
              <Button label="Pop to root" onPress={controller.popToRoot} />
              <Button label="Refresh FCM" onPress={controller.refreshActiveFcm} />
            </View>
          </Section>

          <Section title="Navigate active (SPA path)">
            <View style={styles.row}>
              <TextInput
                value={navInput}
                onChangeText={setNavInput}
                placeholder="/board/12"
                placeholderTextColor="#7d7d82"
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                onSubmitEditing={onNavigate}
              />
              <Button label="Go" onPress={onNavigate} />
            </View>
          </Section>

          <Section title="Dev session">
            <View style={styles.row}>
              <Button label="Save" onPress={() => void onSave()} />
              <Button label="Load + Restore" onPress={() => void onLoad()} />
            </View>
          </Section>

          {note ? <Text style={styles.note}>{note}</Text> : null}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    maxHeight: '75%',
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#3a3a3c',
  },
  title: { color: '#fff', fontSize: 16, fontWeight: '700' },
  close: { color: '#8e8e93', fontSize: 18, fontWeight: '600' },
  body: { paddingHorizontal: 16 },
  bodyContent: { paddingVertical: 12, gap: 4 },
  section: { paddingVertical: 8 },
  sectionTitle: {
    color: '#0a84ff',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  mono: { color: '#e5e5ea', fontSize: 13, fontFamily: 'monospace', lineHeight: 18 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  button: {
    backgroundColor: '#2c2c2e',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#48484a',
  },
  buttonPressed: { backgroundColor: '#3a3a3c' },
  buttonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  input: {
    flex: 1,
    minWidth: 120,
    backgroundColor: '#2c2c2e',
    color: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    fontSize: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#48484a',
  },
  stackRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, gap: 10 },
  stackIndex: { color: '#8e8e93', fontSize: 13, width: 18, textAlign: 'center', fontFamily: 'monospace' },
  stackIndexActive: { color: '#30d158' },
  stackInfo: { flex: 1 },
  stackPath: { color: '#e5e5ea', fontSize: 13, fontWeight: '600' },
  stackUrl: { color: '#8e8e93', fontSize: 11, fontFamily: 'monospace' },
  note: { color: '#30d158', fontSize: 12, marginTop: 8, textAlign: 'center' },
});
