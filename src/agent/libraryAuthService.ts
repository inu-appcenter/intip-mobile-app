import * as SecureStore from 'expo-secure-store';
import { PortalSecureStore } from './secureStore';

const KEY_LIB_TOKEN = 'intip_lib_access_token';
const KEY_LIB_USER = 'intip_lib_user_info';
const KEY_LIB_CREDENTIALS = 'intip_lib_credentials';

export interface LibraryUserInfo {
  id: number;
  memberNo: string;
  name: string;
  deptName?: string;
  patronTypeName?: string;
  patronStateName?: string;
}

export interface LibraryCredentials {
  loginId: string;
  password: string;
}

export const LibraryAuthService = {
  /**
   * 도서관 계정 정보 및 토큰 로컬 보안 저장
   */
  async saveCredentials(credentials: LibraryCredentials): Promise<void> {
    await SecureStore.setItemAsync(KEY_LIB_CREDENTIALS, JSON.stringify(credentials), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
    // 통합 포털 계정(학번/비밀번호)에도 자동 동기화하여 1회 로그인으로 전체 서비스 연동
    try {
      await PortalSecureStore.saveCredentials({
        studentId: credentials.loginId,
        password: credentials.password,
      });
    } catch {}
  },

  async getCredentials(): Promise<LibraryCredentials | null> {
    const raw = await SecureStore.getItemAsync(KEY_LIB_CREDENTIALS);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.loginId && parsed?.password) return parsed;
      } catch {}
    }
    // 포털 통합 계정이 이미 기기에 등록되어 있다면 자동 상속
    try {
      const portalCreds = await PortalSecureStore.getCredentials();
      if (portalCreds?.studentId && portalCreds?.password) {
        return {
          loginId: portalCreds.studentId,
          password: portalCreds.password,
        };
      }
    } catch {}
    return null;
  },

  async saveToken(token: string): Promise<void> {
    await SecureStore.setItemAsync(KEY_LIB_TOKEN, token, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  },

  async getToken(): Promise<string | null> {
    return await SecureStore.getItemAsync(KEY_LIB_TOKEN);
  },

  async saveUserInfo(userInfo: LibraryUserInfo): Promise<void> {
    await SecureStore.setItemAsync(KEY_LIB_USER, JSON.stringify(userInfo), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  },

  async getUserInfo(): Promise<LibraryUserInfo | null> {
    const raw = await SecureStore.getItemAsync(KEY_LIB_USER);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  /**
   * 학산도서관 자체 로그인 실행
   */
  async login(credentials?: LibraryCredentials): Promise<{ success: boolean; token?: string; user?: LibraryUserInfo; errorMessage?: string }> {
    const targetCreds = credentials || (await this.getCredentials());
    if (!targetCreds?.loginId || !targetCreds?.password) {
      return { success: false, errorMessage: '도서관 로그인 정보가 없습니다.' };
    }

    try {
      const response = await fetch('https://lib.inu.ac.kr/pyxis-api/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 INTIP-Mobile',
          'Origin': 'https://lib.inu.ac.kr',
        },
        body: JSON.stringify({
          loginId: targetCreds.loginId,
          password: targetCreds.password,
          isFamilyLogin: false,
          isMobile: true,
        }),
      });

      const result = await response.json();

      if (result.success && result.data?.accessToken) {
        const token = result.data.accessToken;
        const user: LibraryUserInfo = {
          id: result.data.id,
          memberNo: result.data.memberNo,
          name: result.data.name,
          deptName: result.data.dept?.name,
          patronTypeName: result.data.patronType?.name,
          patronStateName: result.data.patronState?.name,
        };

        await this.saveCredentials(targetCreds);
        await this.saveToken(token);
        await this.saveUserInfo(user);

        return { success: true, token, user };
      } else {
        return { success: false, errorMessage: result.message || '도서관 로그인에 실패했습니다.' };
      }
    } catch (err: any) {
      return { success: false, errorMessage: err.message || '네트워크 오류가 발생했습니다.' };
    }
  },

  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(KEY_LIB_CREDENTIALS);
    await SecureStore.deleteItemAsync(KEY_LIB_TOKEN);
    await SecureStore.deleteItemAsync(KEY_LIB_USER);
  },
};
