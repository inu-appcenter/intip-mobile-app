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

import 'expo-router/entry';
