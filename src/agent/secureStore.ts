import * as SecureStore from 'expo-secure-store';

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

    await SecureStore.setItemAsync(KEY_PORTAL_ID, studentId.trim(), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
    await SecureStore.setItemAsync(KEY_PORTAL_PW, password.trim(), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
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
