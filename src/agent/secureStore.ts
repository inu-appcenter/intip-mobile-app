import * as SecureStore from 'expo-secure-store';

/**
 * 학교 계정 비밀값 저장 옵션.
 * - iOS: Keychain(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly) — iCloud 백업·기기 이전으로
 *   복사되지 않고 이 기기에만 남는다. 잠금 상태에서도 읽혀야 백그라운드 좌석 감시가 동작하므로
 *   WHEN_UNLOCKED 대신 AFTER_FIRST_UNLOCK 계열을 쓴다.
 * - Android: expo-secure-store가 Android Keystore 키로 AES 암호화해 저장(옵션 무관).
 */
export const DEVICE_ONLY_SECRET: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/**
 * expo-secure-store의 iOS update 경로는 접근성 속성을 바꾸지 않으므로, 기존 항목을
 * 지우고 새로 써서 DEVICE_ONLY_SECRET가 확실히 적용되게 한다.
 */
export async function saveDeviceSecret(key: string, value: string): Promise<void> {
  await SecureStore.deleteItemAsync(key).catch(() => {});
  await SecureStore.setItemAsync(key, value, DEVICE_ONLY_SECRET);
}

const KEY_PORTAL_ID = 'intip_portal_student_id';
const KEY_PORTAL_PW = 'intip_portal_password';

export interface PortalCredentials {
  studentId: string;
  password: string;
}

/**
 * 사용자 포털 학번 및 비밀번호를 기기 하드웨어 보안 영역(iOS Keychain / Android KeyStore)에
 * 안전하게 암호화하여 저장/조회/삭제하는 모듈.
 * (INTIP 서버로는 절대 전송되지 않음)
 */
export const PortalSecureStore = {
  async saveCredentials(credentials: PortalCredentials): Promise<void> {
    const { studentId, password } = credentials;
    if (!studentId || !password) {
      throw new Error('학번과 비밀번호를 모두 입력해 주세요.');
    }

    await saveDeviceSecret(KEY_PORTAL_ID, studentId.trim());
    await saveDeviceSecret(KEY_PORTAL_PW, password.trim());
  },

  async getCredentials(): Promise<PortalCredentials | null> {
    const studentId = await SecureStore.getItemAsync(KEY_PORTAL_ID);
    const password = await SecureStore.getItemAsync(KEY_PORTAL_PW);

    if (!studentId || !password) {
      return null;
    }

    return { studentId, password };
  },

  async hasCredentials(): Promise<boolean> {
    const creds = await this.getCredentials();
    return creds !== null;
  },

  async clearCredentials(): Promise<void> {
    await SecureStore.deleteItemAsync(KEY_PORTAL_ID);
    await SecureStore.deleteItemAsync(KEY_PORTAL_PW);
  },
};
