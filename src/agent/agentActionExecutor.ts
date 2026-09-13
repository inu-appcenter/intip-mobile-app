import { LibraryAuthService } from './libraryAuthService';
import { LmsAuthService } from './lmsAuthService';
import { PortalSecureStore } from './secureStore';

/**
 * AI 에이전트로부터 하달되는 범용 액션 명령 규격 (Generic Protocol)
 */
export interface ClientActionInstruction {
  actionId: string;
  authDomain: 'LIBRARY' | 'PORTAL' | 'LMS' | 'NONE';
  request: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    url: string;
    headers?: Record<string, string>;
    body?: any;
    params?: Record<string, string | number | boolean>;
  };
}

/**
 * 액션 실행 결과 보고 규격
 */
export interface ClientActionResult {
  actionId: string;
  success: boolean;
  statusCode?: number;
  data?: any;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * 범용 클라이언트 액션 실행 엔진 (Agent Action Executor)
 * 특정 도메인 비즈니스 로직에 종속되지 않고, authDomain에 맞춰 인증 정보를 자동 주입하여 요청을 수행.
 */
export async function executeAgentAction(
  instruction: ClientActionInstruction
): Promise<ClientActionResult> {
  const { actionId, authDomain, request } = instruction;

  try {
    let finalUrl = request.url;
    if (request.params && Object.keys(request.params).length > 0) {
      const urlObj = new URL(request.url);
      Object.entries(request.params).forEach(([key, val]) => {
        urlObj.searchParams.append(key, String(val));
      });
      finalUrl = urlObj.toString();
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json;charset=UTF-8',
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 INTIP-Mobile',
      ...(request.headers || {}),
    };

    // 1. 도메인별 인증 세션 자동 주입
    if (authDomain === 'LIBRARY') {
      let token = await LibraryAuthService.getToken();
      if (!token) {
        // 토큰이 없거나 만료되었을 경우 저장된 계정으로 자동 로그인 시도
        const loginRes = await LibraryAuthService.login();
        if (loginRes.success && loginRes.token) {
          token = loginRes.token;
        } else {
          return {
            actionId,
            success: false,
            errorCode: 'AUTH_REQUIRED',
            errorMessage: '도서관 로그인이 필요합니다.',
          };
        }
      }
      headers['Pyxis-Auth-Token'] = token;
    } else if (authDomain === 'LMS') {
      let lmsToken = await LmsAuthService.getToken();
      if (!lmsToken) {
        const loginRes = await LmsAuthService.login();
        if (loginRes.success && loginRes.token) {
          lmsToken = loginRes.token;
        } else {
          return {
            actionId,
            success: false,
            errorCode: 'AUTH_REQUIRED',
            errorMessage: 'LMS 로그인이 필요합니다.',
          };
        }
      }

      // Moodle WebService는 wstoken을 쿼리 또는 파라미터로 전달
      const urlObj = new URL(finalUrl);
      urlObj.searchParams.set('wstoken', lmsToken);
      urlObj.searchParams.set('moodlewsrestformat', 'json');
      finalUrl = urlObj.toString();
    }

    // 2. HTTP 요청 실행
    const fetchOptions: RequestInit = {
      method: request.method,
      headers,
    };

    if (request.body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())) {
      fetchOptions.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    }

    const response = await fetch(finalUrl, fetchOptions);
    const contentType = response.headers.get('content-type') || '';

    let resData: any = null;
    if (contentType.includes('application/json')) {
      resData = await response.json().catch(() => null);
    } else {
      resData = await response.text().catch(() => null);
    }

    // 도서관 세션 만료(401/needLogin) 발생 시 1회 자동 갱신 및 재시도 로직
    if (
      authDomain === 'LIBRARY' &&
      resData &&
      (resData.code === 'error.authentication.needLogin' || response.status === 401)
    ) {
      const relogin = await LibraryAuthService.login();
      if (relogin.success && relogin.token) {
        headers['Pyxis-Auth-Token'] = relogin.token;
        const retryRes = await fetch(finalUrl, { ...fetchOptions, headers });
        const retryData = await retryRes.json().catch(() => null);
        return {
          actionId,
          success: retryRes.ok && retryData?.success !== false,
          statusCode: retryRes.status,
          data: retryData,
        };
      }
    }

    // LMS 세션 만료(invalidtoken/accessexception) 발생 시 1회 자동 갱신 및 재시도 로직
    if (
      authDomain === 'LMS' &&
      resData &&
      (resData.errorcode === 'invalidtoken' || resData.errorcode === 'accessexception')
    ) {
      const relogin = await LmsAuthService.login();
      if (relogin.success && relogin.token) {
        const retryUrlObj = new URL(finalUrl);
        retryUrlObj.searchParams.set('wstoken', relogin.token);
        const retryRes = await fetch(retryUrlObj.toString(), fetchOptions);
        const retryData = await retryRes.json().catch(() => null);
        const isRetrySuccess = retryRes.ok && (!retryData || (!retryData.error && !retryData.exception));
        return {
          actionId,
          success: isRetrySuccess,
          statusCode: retryRes.status,
          data: retryData,
          errorCode: isRetrySuccess ? undefined : (retryData?.errorcode || 'LMS_ERROR'),
          errorMessage: isRetrySuccess ? undefined : (retryData?.message || 'LMS 요청 실패'),
        };
      }
    }

    let isSuccess = response.ok && (!resData || resData.success !== false);
    if (authDomain === 'LMS' && resData && (resData.error || resData.exception)) {
      isSuccess = false;
    }

    return {
      actionId,
      success: isSuccess,
      statusCode: response.status,
      data: resData,
      errorCode: isSuccess ? undefined : (resData?.code || resData?.errorcode || `HTTP_${response.status}`),
      errorMessage: isSuccess ? undefined : (resData?.message || resData?.error || response.statusText),
    };
  } catch (error: any) {
    return {
      actionId,
      success: false,
      errorCode: 'NETWORK_EXCEPTION',
      errorMessage: error?.message || '네트워크 통신 중 오류가 발생했습니다.',
    };
  }
}
