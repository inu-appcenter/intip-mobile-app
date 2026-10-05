import { Platform } from 'react-native';
import IntipAndroidLiveUpdateModule, {
  LiveUpdateOptions,
  LiveUpdateResult,
  LiveUpdateSegment,
} from './src/IntipAndroidLiveUpdateModule';

export { LiveUpdateOptions, LiveUpdateResult, LiveUpdateSegment };

export const IntipAndroidLiveUpdate = {
  /**
   * Android 16 (API 36+) 및 Samsung One UI 8 Live Update Notification(Now Bar) 지원 여부
   */
  isSupported(): boolean {
    if (Platform.OS !== 'android' || !IntipAndroidLiveUpdateModule) {
      return false;
    }
    try {
      return IntipAndroidLiveUpdateModule.isSupported();
    } catch {
      return false;
    }
  },

  /**
   * 사용자의 승격 알림 허용 여부
   */
  canPostPromoted(): boolean {
    if (Platform.OS !== 'android' || !IntipAndroidLiveUpdateModule) {
      return false;
    }
    try {
      return IntipAndroidLiveUpdateModule.canPostPromoted();
    } catch {
      return false;
    }
  },

  /**
   * Live Update Notification 시작 또는 상태 갱신
   */
  startOrUpdateLiveUpdate(options: LiveUpdateOptions): LiveUpdateResult {
    if (Platform.OS !== 'android' || !IntipAndroidLiveUpdateModule) {
      return { success: false, error: 'Not supported on this platform' };
    }
    try {
      return IntipAndroidLiveUpdateModule.startOrUpdateLiveUpdate(options);
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },

  /**
   * Live Update Notification 취소
   */
  stopLiveUpdate(id: number): boolean {
    if (Platform.OS !== 'android' || !IntipAndroidLiveUpdateModule) {
      return false;
    }
    try {
      return IntipAndroidLiveUpdateModule.stopLiveUpdate(id);
    } catch {
      return false;
    }
  },

  /**
   * 시스템의 실시간 알림(Live Update / Now Bar) 설정 화면으로 직접 이동
   */
  openPromotionSettings(): boolean {
    if (Platform.OS !== 'android' || !IntipAndroidLiveUpdateModule) {
      return false;
    }
    try {
      return IntipAndroidLiveUpdateModule.openPromotionSettings();
    } catch {
      return false;
    }
  },
};
