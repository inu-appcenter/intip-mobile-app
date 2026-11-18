import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { executeAgentAction, type ClientActionInstruction } from '../agentActionExecutor';
import { PortalSecureStore } from '../secureStore';
import { AcademicScraperManager } from '../AcademicScraperWebView';

jest.mock('../../native/downloads', () => ({
  saveDownload: jest.fn(),
}));

jest.mock('../secureStore', () => ({
  PortalSecureStore: {
    getCredentials: jest.fn(),
  },
}));

jest.mock('../AcademicScraperWebView', () => ({
  AcademicScraperManager: {
    executeErpAction: jest.fn(),
  },
}));

describe('agentActionExecutor 보안 가드 테스트', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (PortalSecureStore.getCredentials as any).mockResolvedValue({
      studentId: '202001234',
      password: 'mypassword123',
    });
    (AcademicScraperManager.executeErpAction as any).mockResolvedValue('{"success": true}');
  });

  it('비인가 외부 URL 대상 포털 액션 요청 시 SSRF를 차단하고 에러를 반환한다', async () => {
    const maliciousInstruction: ClientActionInstruction = {
      actionId: 'MALICIOUS_SSRF_TEST',
      authDomain: 'PORTAL',
      request: {
        method: 'POST',
        url: 'https://attacker.evil-site.com/steal-session',
      },
    };

    const result = await executeAgentAction(maliciousInstruction);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('UNAUTHORIZED_TARGET');
    expect(AcademicScraperManager.executeErpAction).not.toHaveBeenCalled();
  });

  it('클라이언트가 타인 학번(stuno)을 변조해 전달해도 로그인된 본인 학번으로 강제 바인딩한다', async () => {
    const spoofedInstruction: ClientActionInstruction = {
      actionId: 'PORTAL_GET_STUDENT_TIMETABLE',
      authDomain: 'PORTAL',
      request: {
        method: 'POST',
        url: 'https://erp.inu.ac.kr:8443/uni/sreg/TsimCtr/findTlsnAplyDetaCtntList.do',
        params: {
          stuno: '201999999', // 타인 학번 변조 시도
          yy: '2026',
        },
        data: {
          stuno: '201999999',
        },
      } as any,
    };

    const result = await executeAgentAction(spoofedInstruction);

    expect(result.success).toBe(true);
    expect(AcademicScraperManager.executeErpAction).toHaveBeenCalledTimes(1);

    const callArgs: any = (AcademicScraperManager.executeErpAction as any).mock.calls[0][0];
    // params와 data의 stuno가 본인 학번('202001234')으로 강제 교체되었는지 확인
    expect(callArgs.target.params.stuno).toBe('202001234');
    expect(callArgs.target.data.stuno).toBe('202001234');
  });

  it('정상적인 대학교 ERP 호스트 요청은 정상 실행된다', async () => {
    const validInstruction: ClientActionInstruction = {
      actionId: 'VALID_ERP_REQUEST',
      authDomain: 'PORTAL',
      request: {
        method: 'POST',
        url: 'https://erp.inu.ac.kr:8443/uni/sreg/TsimCtr/findBaseSchregInfoOne.do',
      },
    };

    const result = await executeAgentAction(validInstruction);

    expect(result.success).toBe(true);
    expect(AcademicScraperManager.executeErpAction).toHaveBeenCalledTimes(1);
  });
});
