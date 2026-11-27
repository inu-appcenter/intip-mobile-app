import { Platform } from 'react-native';
import NativeModule, {
  RelayRecentEntry,
  RelaySourceApp,
} from './src/IntipNotificationRelayModule';
import { NotificationRelayConfig, validateRelayConfig } from './src/config';

export * from './src/config';
export { RelayRecentEntry, RelaySourceApp };

/**
 * 다른 앱(스마트캠퍼스)의 알림을 키워드로 분류해 INTIP 알림으로 다시 보내는 기능의 JS 진입점.
 * 설계와 플랫폼별 제약은 docs/notification-relay/plan.md 참고.
 */
export const NotificationRelay = {
  isAvailable(): boolean {
    return NativeModule != null;
  },

  /** 검증 후 저장. 문제가 있으면 저장하지 않고 문제 목록을 돌려준다. */
  saveConfig(config: NotificationRelayConfig): { ok: true } | { ok: false; problems: string[] } {
    const problems = validateRelayConfig(config).filter(
      // 패키지명 경고는 iOS에서는 의미가 없다.
      (p) => Platform.OS === 'android' || !p.startsWith('Android:'),
    );
    if (problems.length > 0) return { ok: false, problems };
    if (!NativeModule) return { ok: false, problems: ['네이티브 모듈이 없습니다(네이티브 재빌드 필요).'] };
    const saved = NativeModule.setConfig(JSON.stringify(config));
    return saved ? { ok: true } : { ok: false, problems: ['설정을 저장하지 못했습니다.'] };
  },

  loadConfig(): NotificationRelayConfig | null {
    const raw = NativeModule?.getConfig();
    if (!raw) return null;
    try {
      return JSON.parse(raw) as NotificationRelayConfig;
    } catch {
      return null;
    }
  },

  getRecent(): RelayRecentEntry[] {
    try {
      return JSON.parse(NativeModule?.getRecent() ?? '[]') as RelayRecentEntry[];
    } catch {
      return [];
    }
  },

  clearRecent(): void {
    NativeModule?.clearRecent();
  },

  /** Android에서만 의미 있음. iOS는 단축어 자동화 설정 여부를 앱이 알 방법이 없다. */
  isListenerPermissionGranted(): boolean {
    if (Platform.OS !== 'android') return false;
    return NativeModule?.isListenerPermissionGranted() ?? false;
  },

  openListenerSettings(): boolean {
    if (Platform.OS !== 'android') return false;
    return NativeModule?.openListenerSettings() ?? false;
  },

  requestRebind(): boolean {
    if (Platform.OS !== 'android') return false;
    return NativeModule?.requestRebind() ?? false;
  },

  getActiveNotificationSources(): RelaySourceApp[] {
    if (Platform.OS !== 'android') return [];
    return NativeModule?.getActiveNotificationSources() ?? [];
  },
};
