import { NativeModule, requireOptionalNativeModule } from 'expo';

export type ActivityPushTokenEvent = {
  /** ActivityKit Activity.id */
  activityId: string;
  /** 이 Activity를 갱신/종료할 APNs push 토큰 (hex) */
  pushToken: string;
  /** expo-widgets ContentState.name (createLiveActivity 이름) */
  name: string;
  /** expo-widgets ContentState.props — 레이아웃 props의 JSON 문자열 */
  props: string;
};

type Events = {
  onActivityPushToken(event: ActivityPushTokenEvent): void;
};

declare class IntipLiveActivityTokensModule extends NativeModule<Events> {}

/**
 * Optional on purpose: the module only exists on iOS, and a JS bundle can
 * outrun the native binary via EAS Update.
 */
export default requireOptionalNativeModule<IntipLiveActivityTokensModule>('IntipLiveActivityTokens');
