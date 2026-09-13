import { PortalSecureStore } from './secureStore';
import { AcademicBasicInfo, parseAcademicBasicInfo } from './ssvParser';
import { AcademicScraperManager } from './AcademicScraperWebView';

export interface AcademicWorkerResult {
  success: boolean;
  data?: AcademicBasicInfo;
  errorCode?: 'NO_CREDENTIALS' | 'LOGIN_FAILED' | 'ERP_ERROR' | 'NETWORK_ERROR';
  errorMessage?: string;
}

/**
 * 포털 SSO 로그인 및 ERP 학적 정보 조회를 단말기(모바일)의 숨김 웹뷰에서 수행하는 워커
 */
export async function fetchAcademicInfoLocally(): Promise<AcademicWorkerResult> {
  const creds = await PortalSecureStore.getCredentials();
  if (!creds) {
    console.warn('[academicWorker] No credentials found in SecureStore');
    return {
      success: false,
      errorCode: 'NO_CREDENTIALS',
      errorMessage: '포털 계정 연동이 필요합니다.',
    };
  }

  try {
    console.log('[academicWorker] Executing academic scrape for student:', creds.studentId);
    const rawSsv = await AcademicScraperManager.executeScrape(creds);
    console.log('[academicWorker] Raw SSV received, length:', rawSsv.length);

    const academicInfo = parseAcademicBasicInfo(rawSsv);
    return {
      success: true,
      data: academicInfo,
    };
  } catch (error: any) {
    console.warn('[academicWorker] fetchAcademicInfoLocally error:', error);
    const msg = error?.message || '학적 정보 조회 중 오류가 발생했습니다.';
    const isLoginError = msg.includes('비밀번호') || msg.includes('아이디') || msg.includes('로그인') || msg.includes('휴면');
    return {
      success: false,
      errorCode: isLoginError ? 'LOGIN_FAILED' : msg.includes('ERP') ? 'ERP_ERROR' : 'NETWORK_ERROR',
      errorMessage: msg,
    };
  }
}
