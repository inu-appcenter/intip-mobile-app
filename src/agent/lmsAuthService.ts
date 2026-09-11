import * as SecureStore from 'expo-secure-store';

const KEY_LMS_TOKEN = 'intip_lms_access_token';
const KEY_LMS_USER = 'intip_lms_user_info';
const KEY_LMS_CREDENTIALS = 'intip_lms_credentials';

export interface LmsUserInfo {
  userid: number;
  username: string;
  fullname: string;
  sitename?: string;
  userpictureurl?: string;
}

export interface LmsCredentials {
  username: string;
  password: string;
}

export const LmsAuthService = {
  /**
   * LMS 계정 정보 및 토큰 로컬 보안 저장
   */
  async saveCredentials(credentials: LmsCredentials): Promise<void> {
    await SecureStore.setItemAsync(KEY_LMS_CREDENTIALS, JSON.stringify(credentials), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  },

  async getCredentials(): Promise<LmsCredentials | null> {
    const raw = await SecureStore.getItemAsync(KEY_LMS_CREDENTIALS);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  async saveToken(token: string): Promise<void> {
    await SecureStore.setItemAsync(KEY_LMS_TOKEN, token, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  },

  async getToken(): Promise<string | null> {
    return await SecureStore.getItemAsync(KEY_LMS_TOKEN);
  },

  async saveUserInfo(userInfo: LmsUserInfo): Promise<void> {
    await SecureStore.setItemAsync(KEY_LMS_USER, JSON.stringify(userInfo), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  },

  async getUserInfo(): Promise<LmsUserInfo | null> {
    const raw = await SecureStore.getItemAsync(KEY_LMS_USER);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  /**
   * LMS Moodle 토큰 발급 로그인
   */
  async login(credentials?: LmsCredentials): Promise<{
    success: boolean;
    token?: string;
    user?: LmsUserInfo;
    errorMessage?: string;
  }> {
    const targetCreds = credentials || (await this.getCredentials());
    if (!targetCreds?.username || !targetCreds?.password) {
      return { success: false, errorMessage: 'LMS 로그인 정보가 없습니다.' };
    }

    try {
      // 1. 토큰 획득
      const tokenRes = await fetch('https://lms.inu.ac.kr/login/token.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 INTIP-Mobile',
        },
        body: new URLSearchParams({
          username: targetCreds.username,
          password: targetCreds.password,
          service: 'moodle_mobile_app',
        }).toString(),
      });

      const tokenData = await tokenRes.json();
      if (!tokenData.token) {
        return {
          success: false,
          errorMessage: tokenData.error || 'LMS 아이디 또는 비밀번호가 일치하지 않습니다.',
        };
      }

      const token = tokenData.token;

      // 2. 사용자 정보 획득 (core_webservice_get_site_info)
      const siteInfoParams = new URLSearchParams({
        wstoken: token,
        wsfunction: 'core_webservice_get_site_info',
        moodlewsrestformat: 'json',
      });

      const siteRes = await fetch(`https://lms.inu.ac.kr/webservice/rest/server.php?${siteInfoParams.toString()}`);
      const siteData = await siteRes.json();

      const user: LmsUserInfo = {
        userid: siteData.userid,
        username: siteData.username,
        fullname: siteData.fullname,
        sitename: siteData.sitename,
        userpictureurl: siteData.userpictureurl,
      };

      await this.saveCredentials(targetCreds);
      await this.saveToken(token);
      await this.saveUserInfo(user);

      return { success: true, token, user };
    } catch (err: any) {
      return { success: false, errorMessage: err.message || 'LMS 서버 통신 중 오류가 발생했습니다.' };
    }
  },

  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(KEY_LMS_CREDENTIALS);
    await SecureStore.deleteItemAsync(KEY_LMS_TOKEN);
    await SecureStore.deleteItemAsync(KEY_LMS_USER);
  },
};
