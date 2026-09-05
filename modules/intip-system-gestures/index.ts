/**
 * How wide the system's own gesture band is, per edge, in dp.
 *
 * The shell needs this to know which touches belong to the Android back gesture
 * rather than to the page (see `buildEdgeLongPressGuardScript`). It is not a
 * constant: One UI reserves 30dp where AOSP reserves 20, Samsung lets the user
 * widen it further with a sensitivity slider, and under button navigation it is
 * 0 because there is no edge gesture at all.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppState, Dimensions, Platform } from 'react-native';

import IntipSystemGesturesModule, {
  type GestureInsets,
} from './src/IntipSystemGesturesModule';

export type { GestureInsets };

/**
 * Used when the native module cannot answer — an iOS build, or a JS bundle that
 * arrived by EAS Update ahead of the native binary that has this module.
 *
 * 30dp is what One UI reserves (measured: 90px at density 3.0), which is wider
 * than AOSP's 20dp. Over-guarding costs a slightly wider strip of dead
 * long-press; under-guarding lets the bug back in, so this errs wide.
 */
export const FALLBACK_GESTURE_EDGE_DP = 30;

function read(): GestureInsets | null {
  if (Platform.OS !== 'android') return null;
  try {
    return IntipSystemGesturesModule?.getGestureInsets() ?? null;
  } catch {
    return null;
  }
}

/**
 * The left/right gesture band, re-read whenever it plausibly changed.
 *
 * There is no native event for this by design (see the Kotlin module's comment
 * on why we don't install an insets listener). Polling is not needed either:
 * the band only changes when the user changes navigation mode or gesture
 * sensitivity in Settings, so returning to the foreground is the signal. A
 * rotation or fold changes the viewport, so dimension changes are worth a
 * re-read too.
 */
export function useSystemGestureBand(): { left: number; right: number } {
  const toBand = useCallback((insets: GestureInsets | null) => {
    if (!insets) {
      return {
        left: FALLBACK_GESTURE_EDGE_DP,
        right: FALLBACK_GESTURE_EDGE_DP,
      };
    }
    // A real zero (button navigation) is honoured: there is no back gesture to
    // guard against, so nothing should be taken away from the page.
    return { left: insets.left, right: insets.right };
  }, []);

  const [band, setBand] = useState(() => toBand(read()));

  useEffect(() => {
    const refresh = () => {
      setBand((previous) => {
        const next = toBand(read());
        return previous.left === next.left && previous.right === next.right
          ? previous
          : next;
      });
    };

    // The first read can land before the activity has a window to measure.
    refresh();

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    const dimensionsSub = Dimensions.addEventListener('change', refresh);
    return () => {
      appStateSub.remove();
      dimensionsSub.remove();
    };
  }, [toBand]);

  return band;
}
