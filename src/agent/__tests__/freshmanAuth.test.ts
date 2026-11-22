import { describe, it, expect } from '@jest/globals';
import vm from 'node:vm';
import {
  buildFreshmanAuthScript,
  freshmanAuthRequestSchema,
  isFreshmanAuthUrl,
  isPortalLoginUrl,
  parseFreshmanAuthMessage,
  FRESHMAN_AUTH_URL,
} from '../freshmanAuth';

describe('freshmanAuth URL 허용 목록', () => {
  it('지정된 https ERP 신입생 인증 문서만 허용한다', () => {
    expect(isFreshmanAuthUrl(FRESHMAN_AUTH_URL)).toBe(true);
    expect(isFreshmanAuthUrl('https://erp.inu.ac.kr/nx/index_external.html')).toBe(true);
  });

  it('부분 문자열 매칭/평문 http/타 호스트/타 경로에는 자격증명을 주입하지 않는다', () => {
    expect(isFreshmanAuthUrl('http://erp.inu.ac.kr:8443/nx/index_external.html')).toBe(false);
    expect(isFreshmanAuthUrl('https://evil.example.com/nx/index_external.html')).toBe(false);
    expect(isFreshmanAuthUrl('https://erp.inu.ac.kr.evil.com/nx/index_external.html')).toBe(false);
    expect(isFreshmanAuthUrl('https://portal.inu.ac.kr:444/x?index_external.html')).toBe(false);
    expect(isFreshmanAuthUrl('https://erp.inu.ac.kr:8443/other.html?index_external.html')).toBe(false);
    expect(isFreshmanAuthUrl('https://erp.inu.ac.kr:8443/nx/index_external.html.evil')).toBe(false);
    expect(isFreshmanAuthUrl('not a url')).toBe(false);
    expect(isFreshmanAuthUrl('')).toBe(false);
    expect(isFreshmanAuthUrl(null)).toBe(false);
  });

  it('포털 로그인 문서 판별도 https + 정확한 호스트를 요구한다', () => {
    expect(isPortalLoginUrl('https://portal.inu.ac.kr:444/enview/user/login.face')).toBe(true);
    expect(isPortalLoginUrl('https://portal.inu.ac.kr:444/enview/user/login.face;jsessionid=ABC')).toBe(true);
    expect(isPortalLoginUrl('http://portal.inu.ac.kr:444/enview/user/login.face')).toBe(false);
    expect(isPortalLoginUrl('https://evil.example.com/portal.inu.ac.kr/login.face')).toBe(false);
    expect(isPortalLoginUrl('https://evil.example.com/?u=portal.inu.ac.kr&login.face')).toBe(false);
  });
});

describe('freshmanAuthRequestSchema', () => {
  it('정상 입력을 trim/문자열화하여 통과시킨다', () => {
    const r = freshmanAuthRequestSchema.safeParse({ examNo: ' 12345678 ', name: ' 홍길동 ', birthDate: 20070101 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ examNo: '12345678', name: '홍길동', birthDate: '20070101' });
  });

  it.each([
    [{ examNo: '', name: '홍길동', birthDate: '20070101' }],
    [{ examNo: '123', name: '', birthDate: '20070101' }],
    [{ examNo: '123', name: '홍길동', birthDate: '2007-01-01' }],
    [{ examNo: '123', name: '홍길동', birthDate: '2007010' }],
    [{ examNo: "1'; alert(1);//", name: '홍길동', birthDate: '20070101' }],
    [{ examNo: '123', name: 'a'.repeat(41), birthDate: '20070101' }],
    [{ examNo: { a: 1 }, name: '홍길동', birthDate: '20070101' }],
    [{ examNo: '123', name: ['x'], birthDate: '20070101' }],
    [null],
    [undefined],
  ])('비정상 입력을 거부한다: %j', (input) => {
    expect(freshmanAuthRequestSchema.safeParse(input).success).toBe(false);
  });
});

function makeSandbox(form: any, posted: any[], cols: Record<string, string> = {}) {
  return {
    window: { ReactNativeWebView: { postMessage: (m: string) => posted.push(JSON.parse(m)) } },
    application: {
      mainframe: { ChildFrame: { form: { div_Work: { form } } } },
      gds_viewSession: { getColumn: (_r: number, c: string) => cols[c] },
    },
    setInterval: (fn: () => void) => {
      fn();
      return 1;
    },
    clearInterval: () => {},
    String,
    JSON,
  } as any;
}

describe('buildFreshmanAuthScript', () => {
  const request = { examNo: '12345678', name: '홍길동', birthDate: '20070101' };

  it('주입 스크립트가 구문 오류 없이 파싱된다 (배치 전체가 죽는 것 방지)', () => {
    expect(() => new vm.Script(buildFreshmanAuthScript(request))).not.toThrow();
  });

  it('따옴표/역슬래시/템플릿 구문이 섞인 성명도 리터럴로 안전하게 이스케이프된다', () => {
    const nasty = {
      examNo: '12345678',
      name: '홍"길\'동\\n`${process.exit()}`</script> ',
      birthDate: '20070101',
    };
    const script = buildFreshmanAuthScript(nasty);
    expect(() => new vm.Script(script)).not.toThrow();

    const posted: any[] = [];
    const sets: Record<string, string> = {};
    const sandbox = makeSandbox(
      {
        DS_COND: { set: (k: string, v: string) => (sets[k] = v) },
        preLoginChk: () => {},
        loginSuccess: () => 1,
      },
      posted,
    );
    sandbox.process = {
      exit: () => {
        throw new Error('INJECTED');
      },
    };
    vm.runInNewContext(script, sandbox);
    expect(sets).toEqual({ j_id: nasty.examNo, nm: nasty.name, birthDt: nasty.birthDate });
    expect(posted).toEqual([]);
  });

  it('폼이 준비되면 loginSuccess 후 세션 정보를 FRESHMAN_AUTH_SUCCESS로 전달하되 입력값은 되돌리지 않는다', () => {
    const posted: any[] = [];
    const cols = { userNm: '홍길동', persNo: 'P1', deptNm: '컴공', deptTtNm: '정보대', userGbn: 'F', encStr: 'ENC' };
    const form: any = { DS_COND: { set: () => {} }, preLoginChk: () => {}, loginSuccess: () => 1 };
    vm.runInNewContext(buildFreshmanAuthScript(request), makeSandbox(form, posted, cols));
    form.loginSuccess();
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('FRESHMAN_AUTH_SUCCESS');
    expect(JSON.stringify(posted[0])).not.toContain('20070101');
    expect(posted[0].data.birthDate).toBeUndefined();
  });

  it('preLoginChk 가 예외를 던지면 조용히 삼키지 않고 FAIL 을 보낸다', () => {
    const posted: any[] = [];
    const form: any = {
      DS_COND: { set: () => {} },
      preLoginChk: () => {
        throw new Error('boom');
      },
    };
    vm.runInNewContext(buildFreshmanAuthScript(request), makeSandbox(form, posted));
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('FRESHMAN_AUTH_FAIL');
  });

  it('스크립트가 민감 입력을 console 로 출력하지 않는다', () => {
    expect(buildFreshmanAuthScript(request)).not.toMatch(/console\./);
  });

  it('DS_COND.get(collYy)가 채워질 때까지 대기했다가 채워진 뒤 preLoginChk 를 호출한다', () => {
    const posted: any[] = [];
    const cols: Record<string, string> = {};
    const intervalRef: { cb: (() => void) | null } = { cb: null };
    let preLoginCalls = 0;

    const form: any = {
      DS_COND: {
        get: (k: string) => cols[k] ?? '',
        set: (k: string, v: string) => {
          cols[k] = v;
        },
      },
      preLoginChk: () => {
        preLoginCalls++;
      },
      loginSuccess: () => 1,
    };

    const sandbox: any = {
      window: { ReactNativeWebView: { postMessage: (m: string) => posted.push(JSON.parse(m)) } },
      application: {
        mainframe: { ChildFrame: { form: { div_Work: { form } } } },
        gds_viewSession: { getColumn: () => '' },
      },
      setInterval: (fn: () => void) => {
        intervalRef.cb = fn;
        fn();
        return 1;
      },
      clearInterval: () => {
        intervalRef.cb = null;
      },
      String,
      JSON,
      Date,
    };

    vm.runInNewContext(buildFreshmanAuthScript(request), sandbox);
    // findDormLogin.do 응답 전: 아직 preLoginChk 호출 안 함
    expect(preLoginCalls).toBe(0);

    // 2틱 후 findDormLogin.do 가 collYy 세팅 완료
    cols.collYy = '2027';
    intervalRef.cb?.();
    expect(preLoginCalls).toBe(1);
    expect(cols.j_id).toBe(request.examNo);
  });

  it('collYy 가 끝내 비어 있으면 25틱 대기 후 동적 입학년도를 폴백으로 채워 실행한다', () => {
    const cols: Record<string, string> = {};
    const intervalRef: { cb: (() => void) | null } = { cb: null };
    let preLoginCalls = 0;

    const form: any = {
      DS_COND: {
        get: (k: string) => cols[k] ?? '',
        set: (k: string, v: string) => {
          cols[k] = v;
        },
      },
      preLoginChk: () => {
        preLoginCalls++;
      },
    };

    const sandbox: any = {
      window: { ReactNativeWebView: { postMessage: () => {} } },
      application: { mainframe: { ChildFrame: { form: { div_Work: { form } } } } },
      setInterval: (fn: () => void) => {
        intervalRef.cb = fn;
        fn();
        return 1;
      },
      clearInterval: () => {
        intervalRef.cb = null;
      },
      String,
      JSON,
      Date,
    };

    vm.runInNewContext(buildFreshmanAuthScript(request), sandbox);
    for (let i = 0; i < 24; i++) {
      intervalRef.cb?.();
    }
    expect(preLoginCalls).toBe(1);
    expect(cols.collYy).toMatch(/^\d{4}$/);
  });

  it('form.utils.alert 호출과 fn_callBack 실패 분기를 가로채 FRESHMAN_AUTH_FAIL 을 즉시 전달하고 afterLogin 리다이렉트를 막는다', () => {
    const posted: any[] = [];
    let redirected = false;
    const form: any = {
      DS_COND: { set: () => {} },
      utils: {
        alert: () => {},
      },
      afterLogin: () => {
        redirected = true;
      },
      preLoginChk: () => {},
      loginSuccess: () => 0,
      fn_callBack: function (svcId: string) {
        if (svcId === 'j_login') {
          form.utils.alert('수험번호 또는 성명이 일치하지 않습니다.');
        }
      },
    };

    vm.runInNewContext(buildFreshmanAuthScript(request), makeSandbox(form, posted));
    // afterLogin 무력화 검증
    form.afterLogin();
    expect(redirected).toBe(false);

    // utils.alert 실패 전달 검증
    form.fn_callBack('j_login');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      type: 'FRESHMAN_AUTH_FAIL',
      message: '수험번호 또는 성명이 일치하지 않습니다.',
    });
  });
});

describe('parseFreshmanAuthMessage', () => {
  it('SUCCESS 는 화이트리스트 필드만 남기고 examNo 는 앱이 기억한 값을 사용한다', () => {
    const r = parseFreshmanAuthMessage(
      {
        type: 'FRESHMAN_AUTH_SUCCESS',
        data: {
          userNm: '홍길동',
          persNo: 'P1',
          deptNm: 'D',
          deptTtNm: 'T',
          userGbn: 'F',
          encStr: 'E',
          examNo: 'SPOOF',
          birthDate: '19000101',
          extra: 'x',
        },
      },
      '12345678',
    );
    expect(r).toEqual({
      ok: true,
      data: { userNm: '홍길동', persNo: 'P1', deptNm: 'D', deptTtNm: 'T', userGbn: 'F', encStr: 'E', examNo: '12345678' },
    });
  });

  it('data 가 없거나 세션 값이 모두 비어 있으면 실패로 처리한다', () => {
    const fail = { ok: false, message: expect.any(String) };
    expect(parseFreshmanAuthMessage({ type: 'FRESHMAN_AUTH_SUCCESS' }, '1')).toEqual(fail);
    expect(parseFreshmanAuthMessage({ type: 'FRESHMAN_AUTH_SUCCESS', data: {} }, '1')).toEqual(fail);
    expect(parseFreshmanAuthMessage({ type: 'FRESHMAN_AUTH_SUCCESS', data: 'str' }, '1')).toEqual(fail);
  });

  it('FAIL 메시지는 길이를 제한하고 비어 있으면 기본 문구를 사용한다', () => {
    const long = parseFreshmanAuthMessage({ type: 'FRESHMAN_AUTH_FAIL', message: 'x'.repeat(5000) }, '1');
    expect(long && !long.ok && long.message.length).toBe(200);
    expect(parseFreshmanAuthMessage({ type: 'FRESHMAN_AUTH_FAIL' }, '1')).toEqual({
      ok: false,
      message: expect.any(String),
    });
  });

  it('관련 없는 메시지는 null', () => {
    expect(parseFreshmanAuthMessage({ type: 'ALERT' }, '1')).toBeNull();
    expect(parseFreshmanAuthMessage(null, '1')).toBeNull();
    expect(parseFreshmanAuthMessage('x', '1')).toBeNull();
  });
});
