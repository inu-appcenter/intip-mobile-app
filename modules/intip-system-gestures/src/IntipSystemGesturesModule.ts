import { NativeModule, requireOptionalNativeModule } from 'expo';

export type GestureInsets = {
  /** dp reserved along each edge for the system's own gestures. */
  left: number;
  right: number;
  top: number;
  bottom: number;
};

declare class IntipSystemGesturesModule extends NativeModule {
  /**
   * Current `systemGestures` insets in dp, or `null` when they could not be
   * read (no activity yet). `null` is not the same as all-zero: zero is what
   * button navigation legitimately reports.
   */
  getGestureInsets(): GestureInsets | null;
}

/**
 * Optional on purpose: the module only exists on Android, and a JS bundle can
 * outrun the native binary via EAS Update. Callers fall back to a constant.
 */
export default requireOptionalNativeModule<IntipSystemGesturesModule>(
  'IntipSystemGestures',
);
