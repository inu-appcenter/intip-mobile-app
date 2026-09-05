import { NativeModule, requireOptionalNativeModule } from 'expo';

export type GestureInsets = {
  /** 시스템 제스처용으로 각 가장자리에 예약된 폭(dp). */
  left: number;
  right: number;
  top: number;
  bottom: number;
};

declare class IntipSystemGesturesModule extends NativeModule {
  /**
   * 현재 systemGestures 인셋(dp). 읽지 못하면 null.
   * null과 0은 다르다. 0은 버튼 내비게이션이 보고하는 정상 값이다.
   */
  getGestureInsets(): GestureInsets | null;
}

/**
 * 의도적으로 optional. 안드로이드에만 있고, EAS Update로 JS만 먼저 나가면
 * 네이티브 바이너리에 이 모듈이 없을 수 있다. 호출부는 상수로 폴백한다.
 */
export default requireOptionalNativeModule<IntipSystemGesturesModule>(
  'IntipSystemGestures',
);
