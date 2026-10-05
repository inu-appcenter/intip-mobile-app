import { NativeModule, requireOptionalNativeModule } from 'expo';

export interface LiveUpdateSegment {
  length: number;
  color?: string;
}

export interface LiveUpdateOptions {
  id?: number;
  channelId?: string;
  channelName?: string;
  title: string;
  text: string;
  shortCriticalText?: string; // 7자 이내 (상태 칩 / 캡슐 텍스트)
  progress?: number; // 0 ~ 100
  segments?: LiveUpdateSegment[];
  targetTimestamp?: number; // ms
  showChronometer?: boolean;
  ongoing?: boolean;
}

export interface LiveUpdateResult {
  success: boolean;
  promotable?: boolean;
  isSupported?: boolean;
  error?: string;
}

declare class IntipAndroidLiveUpdateModule extends NativeModule {
  isSupported(): boolean;
  canPostPromoted(): boolean;
  startOrUpdateLiveUpdate(options: LiveUpdateOptions): LiveUpdateResult;
  stopLiveUpdate(id: number): boolean;
  openPromotionSettings(): boolean;
}

export default requireOptionalNativeModule<IntipAndroidLiveUpdateModule>(
  'IntipAndroidLiveUpdate',
);
