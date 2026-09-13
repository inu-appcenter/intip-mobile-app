import { PortalSecureStore } from './secureStore';
import { fetchAcademicInfoLocally } from './academicWorker';
import { LibraryAuthService } from './libraryAuthService';
import { LmsAuthService } from './lmsAuthService';
import { executeAgentAction } from './agentActionExecutor';
import { LocalWatchManager } from './localWatchManager';

export interface AgentBridgeResponse {
  type: string;
  requestId?: string;
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
  const targetRequestId = parsed.requestId || payload?.instruction?.actionId;

  // 모든 응답에 요청 고유 ID(requestId)를 동기화하여 다중 비동기 브릿지 호출 시 충돌/혼선 방지
  const sendWrappedResponse = (res: AgentBridgeResponse) => {
    sendResponse({
      ...res,
      ...(targetRequestId ? { requestId: targetRequestId } : {}),
    });
  };

  switch (type) {
    case 'checkPortalAccount': {
      try {
        const has = await PortalSecureStore.hasCredentials();
        sendWrappedResponse({
          type: 'checkPortalAccountResult',
          success: true,
          data: { linked: has },
        });
      } catch (err: any) {
        sendWrappedResponse({
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
        // 백그라운드에서 LMS 및 도서관 토큰도 즉시 선발급 시도 (1회 등록으로 올패스 연동)
        LmsAuthService.login({ username: studentId, password }).catch(() => {});
        LibraryAuthService.login({ loginId: studentId, password }).catch(() => {});
        sendWrappedResponse({
          type: 'savePortalAccountResult',
          success: true,
          data: { linked: true },
        });
      } catch (err: any) {
        sendWrappedResponse({
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
        await LmsAuthService.clear().catch(() => {});
        await LibraryAuthService.clear().catch(() => {});
        sendWrappedResponse({
          type: 'deletePortalAccountResult',
          success: true,
          data: { linked: false },
        });
      } catch (err: any) {
        sendWrappedResponse({
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
        sendWrappedResponse({
          type: 'fetchAcademicInfoResult',
          success: result.success,
          data: result.data,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        });
      } catch (err: any) {
        sendWrappedResponse({
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
        sendWrappedResponse({
          type: 'saveLibraryAccountResult',
          success: loginRes.success,
          data: loginRes.user,
          errorMessage: loginRes.errorMessage,
        });
      } catch (err: any) {
        sendWrappedResponse({
          type: 'saveLibraryAccountResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    case 'checkLibraryAccount': {
      try {
        let token = await LibraryAuthService.getToken();
        if (!token) {
          const autoLogin = await LibraryAuthService.login();
          if (autoLogin.success) {
            token = autoLogin.token || null;
          }
        }
        const user = await LibraryAuthService.getUserInfo();
        sendWrappedResponse({
          type: 'checkLibraryAccountResult',
          success: true,
          data: { linked: Boolean(token), user },
        });
      } catch (err: any) {
        sendWrappedResponse({
          type: 'checkLibraryAccountResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    case 'saveLmsAccount': {
      try {
        const { username, password } = payload || {};
        const loginRes = await LmsAuthService.login({ username, password });
        sendWrappedResponse({
          type: 'saveLmsAccountResult',
          success: loginRes.success,
          data: loginRes.user,
          errorMessage: loginRes.errorMessage,
        });
      } catch (err: any) {
        sendWrappedResponse({
          type: 'saveLmsAccountResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    case 'checkLmsAccount': {
      try {
        let token = await LmsAuthService.getToken();
        if (!token) {
          const autoLogin = await LmsAuthService.login();
          if (autoLogin.success) {
            token = autoLogin.token || null;
          }
        }
        const user = await LmsAuthService.getUserInfo();
        sendWrappedResponse({
          type: 'checkLmsAccountResult',
          success: true,
          data: { linked: Boolean(token), user },
        });
      } catch (err: any) {
        sendWrappedResponse({
          type: 'checkLmsAccountResult',
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
        sendWrappedResponse({
          type: 'executeAgentActionResult',
          success: actionResult.success,
          data: actionResult.data !== undefined ? actionResult.data : actionResult,
          errorCode: actionResult.errorCode,
          errorMessage: actionResult.errorMessage,
        });
      } catch (err: any) {
        sendWrappedResponse({
          type: 'executeAgentActionResult',
          success: false,
          errorCode: 'EXECUTION_ERROR',
          errorMessage: err?.message,
        });
      }
      return true;
    }

    case 'getLocalWatchJobs': {
      try {
        const jobs = await LocalWatchManager.getJobs();
        sendWrappedResponse({
          type: 'getLocalWatchJobsResult',
          success: true,
          data: jobs,
        });
      } catch (err: any) {
        sendWrappedResponse({
          type: 'getLocalWatchJobsResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    case 'registerLocalWatchJob': {
      try {
        const { watchType, roomId, roomName, hopeDate, targetHour, durationMinutes, seatName, seatNo, seatId, endTime } = payload || {};
        let job;
        if (watchType === 'STUDY_ROOM_SNIPER') {
          if (!roomId || !targetHour) {
            throw new Error('roomId 및 targetHour 파라미터가 필요합니다.');
          }
          job = await LocalWatchManager.registerStudyRoomSniper({
            roomId: Number(roomId),
            roomName: roomName || `${roomId}호`,
            hopeDate: hopeDate || new Date().toISOString().split('T')[0],
            targetHour: Number(targetHour),
            durationMinutes: durationMinutes ? Number(durationMinutes) : 60,
          });
        } else if (watchType === 'SPECIFIC_SEAT_SNIPER') {
          if (!roomId || (!seatNo && !seatId)) {
            throw new Error('roomId 및 seatNo(또는 seatId) 파라미터가 필요합니다.');
          }
          job = await LocalWatchManager.registerSpecificSeatSniper({
            roomId: Number(roomId),
            roomName: roomName || `${roomId}번 열람실`,
            seatId: seatId ? Number(seatId) : undefined,
            seatNo: String(seatNo || seatId),
            durationMinutes: durationMinutes ? Number(durationMinutes) : 90,
          });
        } else if (watchType === 'SEAT_EXPIRATION') {
          if (!seatName || !endTime) {
            throw new Error('seatName 및 endTime 파라미터가 필요합니다.');
          }
          job = await LocalWatchManager.registerSeatExpirationReminder({
            seatName,
            endTime,
          });
        } else if (watchType === 'ASSIGNMENT_REMINDER') {
          if (!seatName || !endTime) {
            throw new Error('assignmentName 및 dueTime 파라미터가 필요합니다.');
          }
          job = await LocalWatchManager.registerAssignmentReminder({
            assignmentName: seatName,
            dueTime: endTime,
          });
        } else {
          throw new Error(`지원하지 않는 로컬 감시 타입입니다: ${watchType}`);
        }

        sendWrappedResponse({
          type: 'registerLocalWatchJobResult',
          success: true,
          data: job,
        });
      } catch (err: any) {
        sendWrappedResponse({
          type: 'registerLocalWatchJobResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    case 'cancelLocalWatchJob': {
      try {
        const { id } = payload || {};
        if (!id) {
          throw new Error('job id가 필요합니다.');
        }
        const cancelled = await LocalWatchManager.cancelJob(id);
        sendWrappedResponse({
          type: 'cancelLocalWatchJobResult',
          success: cancelled,
          data: { id, cancelled },
        });
      } catch (err: any) {
        sendWrappedResponse({
          type: 'cancelLocalWatchJobResult',
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
