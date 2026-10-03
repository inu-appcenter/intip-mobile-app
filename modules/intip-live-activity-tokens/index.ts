/**
 * 시간표 Live Activity의 ActivityKit 업데이트 push 토큰 관찰 (iOS 전용).
 *
 * 서버 push-to-start로 시작된 것까지 포함해 Activity마다 토큰을 받는다. 서버는 이 토큰으로 수업
 * 시작 때 "수업 중"으로 갱신하고 수업이 끝나면 Activity를 끝낸다 — 앱이 꺼져 있어도.
 */
import IntipLiveActivityTokensModule, { type ActivityPushTokenEvent } from './src/IntipLiveActivityTokensModule';

export type { ActivityPushTokenEvent };

export function addActivityPushTokenListener(
  listener: (event: ActivityPushTokenEvent) => void,
): { remove(): void } {
  if (!IntipLiveActivityTokensModule) return { remove() {} };
  return IntipLiveActivityTokensModule.addListener('onActivityPushToken', listener);
}
