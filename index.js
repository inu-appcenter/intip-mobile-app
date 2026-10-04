/**
 * Custom entry point, instead of pointing `package.json`'s `main` straight at
 * `expo-router/entry`.
 *
 * It exists for one reason: Android can start this bundle with no UI at all,
 * to refresh a home screen widget (see `src/widgets/headless.ts`). That path
 * looks the task up by name the moment the bundle finishes evaluating, so the
 * registration has to be a plain top-level side effect of the entry itself —
 * anywhere inside the React tree is already too late, because in a headless
 * start there is no React tree.
 */
import './src/widgets/headless';
import { registerBackgroundHandlers } from './src/push/messaging';

import 'expo-router/entry';

// Same reason, for FCM and notifee: a data-only push or a notification
// dismissed while the app is killed starts the bundle headless too. Registered
// from `_layout.tsx` instead, these never existed in that start — expo-router
// only evaluates route modules while rendering — and every such event was
// dropped with "[notifee] no background event handler has been set".
registerBackgroundHandlers();
