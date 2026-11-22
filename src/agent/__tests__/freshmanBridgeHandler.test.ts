import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { handleAgentBridgeMessage, type AgentBridgeResponse } from '../agentBridgeHandler';
import { AcademicScraperManager } from '../AcademicScraperWebView';
import { getFreshmanAppCheckToken } from '../appCheck';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../secureStore', () => ({ PortalSecureStore: {} }));
jest.mock('../academicWorker', () => ({ fetchAcademicInfoLocally: jest.fn() }));
jest.mock('../libraryAuthService', () => ({ LibraryAuthService: {} }));
jest.mock('../lmsAuthService', () => ({ LmsAuthService: {} }));
jest.mock('../agentActionExecutor', () => ({ executeAgentAction: jest.fn() }));
jest.mock('../localWatchManager', () => ({ LocalWatchManager: {} }));
jest.mock('../../library/libraryOngoingService', () => ({ LibraryOngoingService: {} }));
jest.mock('../../lms/lmsOngoingService', () => ({ LmsOngoingService: {} }));
jest.mock('../AcademicScraperWebView', () => ({
  AcademicScraperManager: { executeErpAction: jest.fn() },
}));
jest.mock('../appCheck', () => ({
  initializeAppCheck: jest.fn(),
  getFreshmanAppCheckToken: jest.fn(),
}));

const send = (payload: unknown, requestId = 'req-1') =>
  JSON.stringify({ type: 'requestFreshmanAuth', requestId, payload });

describe('requestFreshmanAuth 브릿지 핸들러', () => {
  let responses: AgentBridgeResponse[];
  let logSpy: any;
  let warnSpy: any;
  const valid = { examNo: '12345678', name: '홍길동', birthDate: '20070101' };

  beforeEach(() => {
    jest.clearAllMocks();
    responses = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (AcademicScraperManager.executeErpAction as any).mockResolvedValue(
      JSON.stringify({ userNm: '홍길동', examNo: valid.examNo }),
    );
    (getFreshmanAppCheckToken as any).mockResolvedValue('appcheck-limited-token');
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it.each([
    [{}],
    [{ examNo: '123' }],
    [{ ...valid, birthDate: '2007-01-01' }],
    [{ ...valid, name: '   ' }],
    [{ ...valid, examNo: "1'; DROP" }],
    [null],
  ])('형식이 잘못된 입력은 스크레이퍼를 호출하지 않고 거부한다: %j', async (payload) => {
    const handled = await handleAgentBridgeMessage(send(payload), (r) => responses.push(r));
    expect(handled).toBe(true);
    expect(AcademicScraperManager.executeErpAction).not.toHaveBeenCalled();
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ type: 'requestFreshmanAuthResult', success: false, requestId: 'req-1' });
  });

  it('정상 입력은 정제된 값으로 FRESHMAN_ERP_AUTH 액션을 실행하고 requestId 를 유지한다', async () => {
    await handleAgentBridgeMessage(
      send({ examNo: 12345678, name: ' 홍길동 ', birthDate: 20070101 }),
      (r) => responses.push(r),
    );
    expect(AcademicScraperManager.executeErpAction).toHaveBeenCalledWith({
      creds: { studentId: '12345678', password: '' },
      actionId: 'FRESHMAN_ERP_AUTH',
      target: { params: valid },
    });
    expect(getFreshmanAppCheckToken).toHaveBeenCalledTimes(1);
    expect(responses[0]).toMatchObject({
      success: true,
      requestId: 'req-1',
      data: { userNm: '홍길동', appCheckToken: 'appcheck-limited-token' },
    });
  });

  it('스크레이프 실패는 success=false 로 전달된다', async () => {
    (AcademicScraperManager.executeErpAction as any).mockRejectedValue(new Error('인증 실패'));
    await handleAgentBridgeMessage(send(valid), (r) => responses.push(r));
    expect(responses[0]).toMatchObject({ success: false, errorMessage: '인증 실패' });
  });

  it('수험번호/성명/생년월일을 로그나 검증 실패 응답에 남기지 않는다', async () => {
    await handleAgentBridgeMessage(send({ ...valid, birthDate: 'bad-secret' }), (r) => responses.push(r));
    await handleAgentBridgeMessage(send(valid), (r) => responses.push(r));
    const logged = JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls]);
    for (const secret of [valid.examNo, valid.name, valid.birthDate, 'bad-secret']) {
      expect(logged).not.toContain(secret);
    }
    expect(JSON.stringify(responses[0])).not.toContain('bad-secret');
  });
});
