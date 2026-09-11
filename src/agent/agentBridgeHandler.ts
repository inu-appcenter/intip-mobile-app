import { PortalSecureStore } from './secureStore';
import { fetchAcademicInfoLocally } from './academicWorker';
import { LibraryAuthService } from './libraryAuthService';
import { executeAgentAction } from './agentActionExecutor';

export interface AgentBridgeResponse {
  type: string;
  success: boolean;
  data?: any;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * AI 에이전트 관련 브릿지 메시지 핸들러
 * 메시지가 에이전트 액션인 경우 처리 후 true 반환, 아니면 false 반환
 */
export async function handleAgentBridgeMessage(
  raw: string,
  sendResponse: (res: AgentBridgeResponse) => void
): Promise<boolean> {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
    return false;
  }

  const { type, payload } = parsed;

  switch (type) {
    case 'checkPortalAccount': {
      try {
        const has = await PortalSecureStore.hasCredentials();
        sendResponse({
          type: 'checkPortalAccountResult',
          success: true,
          data: { linked: has },
        });
      } catch (err: any) {
        sendResponse({
          type: 'checkPortalAccountResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    case 'savePortalAccount': {
      try {
        const { studentId, password } = payload || {};
        await PortalSecureStore.saveCredentials({ studentId, password });
        sendResponse({
          type: 'savePortalAccountResult',
          success: true,
          data: { linked: true },
        });
      } catch (err: any) {
        sendResponse({
          type: 'savePortalAccountResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    case 'deletePortalAccount': {
      try {
        await PortalSecureStore.clearCredentials();
        sendResponse({
          type: 'deletePortalAccountResult',
          success: true,
          data: { linked: false },
        });
      } catch (err: any) {
        sendResponse({
          type: 'deletePortalAccountResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    case 'fetchAcademicInfo': {
      try {
        const result = await fetchAcademicInfoLocally();
        sendResponse({
          type: 'fetchAcademicInfoResult',
          success: result.success,
          data: result.data,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        });
      } catch (err: any) {
        sendResponse({
          type: 'fetchAcademicInfoResult',
          success: false,
          errorCode: 'NETWORK_ERROR',
          errorMessage: err?.message || '학적 정보 조회 실패',
        });
      }
      return true;
    }

    case 'saveLibraryAccount': {
      try {
        const { loginId, password } = payload || {};
        const loginRes = await LibraryAuthService.login({ loginId, password });
        sendResponse({
          type: 'saveLibraryAccountResult',
          success: loginRes.success,
          data: loginRes.user,
          errorMessage: loginRes.errorMessage,
        });
      } catch (err: any) {
        sendResponse({
          type: 'saveLibraryAccountResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    case 'checkLibraryAccount': {
      try {
        const token = await LibraryAuthService.getToken();
        const user = await LibraryAuthService.getUserInfo();
        sendResponse({
          type: 'checkLibraryAccountResult',
          success: true,
          data: { linked: Boolean(token), user },
        });
      } catch (err: any) {
        sendResponse({
          type: 'checkLibraryAccountResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    case 'executeAgentAction': {
      try {
        const instruction = payload?.instruction;
        if (!instruction) {
          throw new Error('instruction 파라미터가 누락되었습니다.');
        }
        const actionResult = await executeAgentAction(instruction);
        sendResponse({
          type: 'executeAgentActionResult',
          success: actionResult.success,
          data: actionResult,
        });
      } catch (err: any) {
        sendResponse({
          type: 'executeAgentActionResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    default:
      return false;
  }
}
