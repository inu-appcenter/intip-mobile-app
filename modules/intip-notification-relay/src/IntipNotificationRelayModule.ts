import { NativeModule, requireOptionalNativeModule } from 'expo';

export interface RelayRecentEntry {
  /** epoch ms */
  at: number;
  /** Android: 원본 패키지명. iOS: 'shortcut'. */
  source: string;
  title: string;
  body: string;
  categoryId: string;
  dropped: boolean;
}

export interface RelaySourceApp {
  packageName: string;
  /** 패키지 가시성(Android 11+) 때문에 못 읽으면 null. */
  label: string | null;
  activeCount: number;
}

declare class IntipNotificationRelayModule extends NativeModule {
  /** 설정 JSON(`NotificationRelayConfig`)을 저장한다. Android는 카테고리별 알림 채널도 맞춘다. */
  setConfig(json: string): boolean;
  getConfig(): string | null;
  /** 최근 분류 내역(JSON 배열 문자열, 최신순, 최대 30개). 기기 밖으로 나가지 않는다. */
  getRecent(): string;
  clearRecent(): void;

  // ---- Android 전용 (iOS에서는 각각 false / [] 를 돌려준다) ----
  /** "알림 접근 허용"이 켜져 있는지. */
  isListenerPermissionGranted(): boolean;
  /** 시스템의 알림 접근 설정 화면(가능하면 INTIP 상세 화면)을 연다. */
  openListenerSettings(): boolean;
  /** 제조사 배터리 최적화 등으로 리스너가 끊겼을 때 다시 바인드를 요청한다. */
  requestRebind(): boolean;
  /** 지금 알림 창에 떠 있는 알림의 출처 앱 목록. 스마트캠퍼스 패키지명을 찾는 용도(내용은 읽지 않음). */
  getActiveNotificationSources(): RelaySourceApp[];
}

export default requireOptionalNativeModule<IntipNotificationRelayModule>('IntipNotificationRelay');
