import { PortalSecureStore } from './secureStore';
import { AcademicBasicInfo, parseAcademicBasicInfo } from './ssvParser';

const PORTAL_LOGIN_URL = 'https://portal.inu.ac.kr:444/enview/user/login.face';
const ERP_SSO_URL = 'http://erp.inu.ac.kr:8881/com/SsoCtr/initPageWork.do?loginGbn=sso';
const ERP_BASE_URL = 'https://erp.inu.ac.kr:8443';
const MENU_ID = 'M002043';
const PROGRAM_ID = 'P001878';
const RECORD_SEPARATOR = String.fromCharCode(30);
const UNIT_SEPARATOR = String.fromCharCode(31);
const NULL_MARKER = String.fromCharCode(3);

export interface AcademicWorkerResult {
  success: boolean;
  data?: AcademicBasicInfo;
  errorCode?: 'NO_CREDENTIALS' | 'LOGIN_FAILED' | 'ERP_ERROR' | 'NETWORK_ERROR';
  errorMessage?: string;
}

function buildBaseSsv(wmonId: string): string {
  return (
    `WMONID=${wmonId}${RECORD_SEPARATOR}` +
    `login_domain=inu.ac.kr${RECORD_SEPARATOR}` +
    `_ba_exist=true${RECORD_SEPARATOR}`
  );
}

function buildAcademicInfoRequestBody(studentId: string, wmonId: string): string {
  const base = buildBaseSsv(wmonId);
  return (
    base +
    `Dataset:DS_COND${RECORD_SEPARATOR}` +
    `_RowType_${UNIT_SEPARATOR}stuno${UNIT_SEPARATOR}korNm${UNIT_SEPARATOR}gbn${UNIT_SEPARATOR}colgGrscCd${UNIT_SEPARATOR}colgCd${UNIT_SEPARATOR}earnMintStom${RECORD_SEPARATOR}` +
    `U${UNIT_SEPARATOR}${studentId}${UNIT_SEPARATOR}${NULL_MARKER}${UNIT_SEPARATOR}${NULL_MARKER}${UNIT_SEPARATOR}${NULL_MARKER}${UNIT_SEPARATOR}${NULL_MARKER}${UNIT_SEPARATOR}1${RECORD_SEPARATOR}` +
    `O${UNIT_SEPARATOR}${NULL_MARKER}${UNIT_SEPARATOR}${NULL_MARKER}${UNIT_SEPARATOR}${NULL_MARKER}${UNIT_SEPARATOR}${NULL_MARKER}${UNIT_SEPARATOR}${NULL_MARKER}${UNIT_SEPARATOR}1${RECORD_SEPARATOR}`
  );
}

/**
 * 포털 SSO 로그인 및 ERP 학적 정보 조회를 단말기(모바일)에서 직접 수행하는 워커
 */
export async function fetchAcademicInfoLocally(): Promise<AcademicWorkerResult> {
  const creds = await PortalSecureStore.getCredentials();
  if (!creds) {
    return {
      success: false,
      errorCode: 'NO_CREDENTIALS',
      errorMessage: '포털 계정 연동이 필요합니다.',
    };
  }

  const { studentId, password } = creds;

  try {
    // 1단계: 포털 로그인 요청
    const formData = new URLSearchParams();
    formData.append('userIdI', studentId);
    formData.append('passwordI', password);

    const loginResp = await fetch(PORTAL_LOGIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      },
      body: formData.toString(),
      redirect: 'follow',
    });

    const loginText = await loginResp.text();

    // 2단계: 쿠키 헤더 추출
    const setCookie = loginResp.headers.get('set-cookie') || '';
    const jsessionIdMatch = setCookie.match(/JSESSIONID=([^;]+)/i);
    const jsessionId = jsessionIdMatch ? jsessionIdMatch[1] : '';

    if (!jsessionId && !loginText.includes('logout') && (loginText.includes('비밀번호') || loginText.includes('아이디') || loginText.includes('실패') || loginText.includes('오류'))) {
      return {
        success: false,
        errorCode: 'LOGIN_FAILED',
        errorMessage: '포털 로그인에 실패했습니다. 학번이나 비밀번호가 올바른지 확인해 주세요.',
      };
    }

    // 3단계: ERP SSO 접근하여 세션 확장
    const erpHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    };
    if (jsessionId) {
      erpHeaders['Cookie'] = `JSESSIONID=${jsessionId}`;
    }

    const erpInitResp = await fetch(ERP_SSO_URL, {
      method: 'GET',
      headers: erpHeaders,
      redirect: 'follow',
    });

    const erpSetCookie = erpInitResp.headers.get('set-cookie') || '';
    const wmonIdMatch = erpSetCookie.match(/WMONID=([^;]+)/i) || setCookie.match(/WMONID=([^;]+)/i);
    const wmonId = wmonIdMatch ? wmonIdMatch[1] : 'intip_mobile_session';

    // 4단계: ERP 기본 정보 쿼리 (SSV)
    const requestBody = buildAcademicInfoRequestBody(studentId, wmonId);
    const queryUrl = `${ERP_BASE_URL}/uni/sreg/TsimCtr/findBaseSchregInfoOne.do?menuId=${MENU_ID}&pgmId=${PROGRAM_ID}`;

    const queryHeaders: Record<string, string> = {
      'Content-Type': 'text/plain; charset=UTF-8',
      'Referer': `${ERP_BASE_URL}/nx/`,
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    };
    if (jsessionId) {
      queryHeaders['Cookie'] = `JSESSIONID=${jsessionId}; WMONID=${wmonId}`;
    }

    const queryResp = await fetch(queryUrl, {
      method: 'POST',
      headers: queryHeaders,
      body: requestBody,
    });

    if (!queryResp.ok) {
      return {
        success: false,
        errorCode: 'ERP_ERROR',
        errorMessage: `ERP 통신 오류 (HTTP ${queryResp.status})`,
      };
    }

    const responseText = await queryResp.text();

    // 5단계: SSV 응답 파싱
    const academicInfo = parseAcademicBasicInfo(responseText);

    return {
      success: true,
      data: academicInfo,
    };
  } catch (error: any) {
    console.warn('[academicWorker] fetchAcademicInfoLocally error:', error);
    return {
      success: false,
      errorCode: error?.message?.includes('ERP') ? 'ERP_ERROR' : 'NETWORK_ERROR',
      errorMessage: error?.message || '학적 정보 조회 중 오류가 발생했습니다.',
    };
  }
}
