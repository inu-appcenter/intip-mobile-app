/** 시스템 백 제스처 영역의 가장자리별 폭(dp). */
import { useCallback, useEffect, useState } from 'react';
import { AppState, Dimensions, Platform } from 'react-native';

import IntipSystemGesturesModule, {
  type GestureInsets,
} from './src/IntipSystemGesturesModule';

export type { GestureInsets };

/** 네이티브 모듈에서 값을 읽지 못할 때 사용할 폴백 폭(dp). */
export const FALLBACK_GESTURE_EDGE_DP = 30;

function read(): GestureInsets | null {
  if (Platform.OS !== 'android') return null;
  try {
    return IntipSystemGesturesModule?.getGestureInsets() ?? null;
  } catch {
    return null;
  }
}

/** 가드를 사용하지 않을 때의 폭. */
const NO_BAND = { left: 0, right: 0 };

/**
 * 앱 활성화·화면 크기 변경 시 시스템 제스처 영역을 다시 읽는다.
 *
 * iOS에서는 항상 0을 돌려준다. 이 밴드는 안드로이드 웹뷰(Chromium)가
 * 백 제스처 터치를 롱프레스로 받아 OS 햅틱을 울리는 문제(#25) 전용 가드이고,
 * WKWebView에는 그 문제가 없다. 반대로 iOS에서 밴드를 잡으면 가장자리
 * touchstart를 preventDefault하게 되어 WebKit의 인터랙티브 백 스와이프가
 * 시작조차 못 한다(가장자리에서 시작한 스와이프만 씹히는 증상).
 */
export function useSystemGestureBand(): { left: number; right: number } {
  const toBand = useCallback((insets: GestureInsets | null) => {
    if (Platform.OS !== 'android') return NO_BAND;
    if (!insets) {
      return {
        left: FALLBACK_GESTURE_EDGE_DP,
        right: FALLBACK_GESTURE_EDGE_DP,
      };
    }
    // 버튼 내비게이션의 0dp는 그대로 사용한다.
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

    // 초기 측정값을 즉시 갱신한다.
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
