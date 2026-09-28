import * as SecureStore from 'expo-secure-store';
import {
  TimetableCourseItem,
  TimetableData,
  TimetableNowBarSettings,
} from './types';

const STORAGE_KEY_TIMETABLE = 'intip_timetable_cache';
const STORAGE_KEY_SETTINGS = 'intip_timetable_nowbar_settings';

export const DEFAULT_NOWBAR_SETTINGS: TimetableNowBarSettings = {
  enabled: true,
  leadTimeMinutes: 15,
};

export const TimetableStorage = {
  /**
   * 저장된 시간표 데이터 불러오기
   */
  async getTimetableData(): Promise<TimetableData | null> {
    try {
      const raw = await SecureStore.getItemAsync(STORAGE_KEY_TIMETABLE);
      if (!raw) return null;
      return JSON.parse(raw) as TimetableData;
    } catch (e) {
      console.error('[TimetableStorage] 시간표 로드 실패:', e);
      return null;
    }
  },

  /**
   * 시간표 데이터 저장
   */
  async saveTimetableData(courses: TimetableCourseItem[]): Promise<TimetableData> {
    const data: TimetableData = {
      updatedAt: Date.now(),
      courses,
    };
    try {
      await SecureStore.setItemAsync(STORAGE_KEY_TIMETABLE, JSON.stringify(data));
    } catch (e) {
      console.error('[TimetableStorage] 시간표 저장 실패:', e);
    }
    return data;
  },

  /**
   * 시간표 데이터 삭제
   */
  async clearTimetableData(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(STORAGE_KEY_TIMETABLE);
    } catch (e) {
      console.error('[TimetableStorage] 시간표 삭제 실패:', e);
    }
  },

  /**
   * 나우바 / Ongoing Activity 설정 조회
   */
  async getSettings(): Promise<TimetableNowBarSettings> {
    try {
      const raw = await SecureStore.getItemAsync(STORAGE_KEY_SETTINGS);
      if (!raw) return DEFAULT_NOWBAR_SETTINGS;
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_NOWBAR_SETTINGS,
        ...parsed,
      };
    } catch {
      return DEFAULT_NOWBAR_SETTINGS;
    }
  },

  /**
   * 나우바 / Ongoing Activity 설정 저장
   */
  async saveSettings(
    newSettings: Partial<TimetableNowBarSettings>
  ): Promise<TimetableNowBarSettings> {
    try {
      const current = await this.getSettings();
      const merged: TimetableNowBarSettings = {
        ...current,
        ...newSettings,
      };
      await SecureStore.setItemAsync(STORAGE_KEY_SETTINGS, JSON.stringify(merged));
      return merged;
    } catch (e) {
      console.error('[TimetableStorage] 설정 저장 실패:', e);
      return DEFAULT_NOWBAR_SETTINGS;
    }
  },

  /**
   * 테스트용 Ongoing Activity 상태 조회 (존재하고 만료되지 않은 경우 반환)
   */
  async getTestActivity(): Promise<any | null> {
    try {
      const raw = await SecureStore.getItemAsync('intip_timetable_test_activity');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed.endTimestamp && Date.now() > parsed.endTimestamp) {
        await this.clearTestActivity();
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  },

  /**
   * 테스트용 Ongoing Activity 상태 저장
   */
  async saveTestActivity(activity: any): Promise<void> {
    try {
      await SecureStore.setItemAsync('intip_timetable_test_activity', JSON.stringify(activity));
    } catch (e) {
      console.error('[TimetableStorage] 테스트 액티비티 저장 실패:', e);
    }
  },

  /**
   * 테스트용 Ongoing Activity 상태 삭제
   */
  async clearTestActivity(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync('intip_timetable_test_activity');
    } catch {}
  },
};
