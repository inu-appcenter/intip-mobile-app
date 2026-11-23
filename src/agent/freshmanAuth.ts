import { z } from 'zod';

/**
 * 신입생 전산망(넥사크로 index_external.html) 인증 보조 로직.
 *
 * 수험번호/성명/생년월일은 대학 자격증명과 동일하게 민감 정보로 취급한다.
 *  - 로그/예외 메시지에 값을 남기지 않는다.
 *  - 지정된 https ERP 로그인 문서에만 주입한다 (부분 문자열 URL 매칭 금지).
 *  - 웹뷰에서 올라온 메시지는 화이트리스트 필드만 신뢰한다.
 *
 * 컴포넌트(AcademicScraperWebView)에서 분리해 순수 함수로 두어 단위 테스트가 가능하다.
 */

export const FRESHMAN_AUTH_URL =
  'https://erp.inu.ac.kr:8443/nx/index_external.html?bG9naW5HYm49ZXgmbWVudUlkPU0wMDI3NDEmc2hvd1RpdGxlPWZhbHNl';

const FRESHMAN_AUTH_HOST = 'erp.inu.ac.kr';
const FRESHMAN_AUTH_PATH = '/nx/index_external.html';
const MAX_ALERT_MESSAGE_LENGTH = 200;

export const FRESHMAN_AUTH_ACTION_ID = 'FRESHMAN_ERP_AUTH';

/** 웹이 보내는 requestFreshmanAuth payload 검증 스키마. */
export const freshmanAuthRequestSchema = z.object({
  examNo: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(z.string().regex(/^[0-9A-Za-z-]{1,20}$/)),
  name: z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1).max(40)),
  birthDate: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(z.string().regex(/^\d{8}$/)),
});

export type FreshmanAuthRequest = z.infer<typeof freshmanAuthRequestSchema>;

/** 웹으로 되돌려주는 세션 정보. 생년월일 등 입력값은 되돌려주지 않는다. */
export interface FreshmanAuthData {
  userNm: string;
  persNo: string;
  deptNm: string;
  deptTtNm: string;
  userGbn: string;
  encStr: string;
  examNo: string;
}

/** 신입생 인증 문서(https://erp.inu.ac.kr[:port]/nx/index_external.html)인지 엄격하게 판별. */
export function isFreshmanAuthUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === FRESHMAN_AUTH_HOST &&
      parsed.pathname === FRESHMAN_AUTH_PATH
    );
  } catch {
    return false;
  }
}

/** 포털 로그인 문서(https://portal.inu.ac.kr[:port]/.../login.face)인지 엄격하게 판별. */
export function isPortalLoginUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'portal.inu.ac.kr' &&
      parsed.pathname.includes('login.face')
    );
  } catch {
    return false;
  }
}

/**
 * 히든 웹뷰에 주입할 스크립트.
 *
 * 주의: 템플릿 리터럴 안에서 `\n`, `\s` 같은 이스케이프는 TS 단계에서 소비되므로
 * 쓰지 않는다. 값은 JSON.stringify 한 번만 거쳐 리터럴로 삽입한다.
 */
export function buildFreshmanAuthScript(request: FreshmanAuthRequest): string {
  const cred = JSON.stringify({
    examNo: request.examNo,
    name: request.name,
    birthDate: request.birthDate,
  });
  return `
    (function() {
      var CRED = ${cred};
      var post = function(payload) {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      };
      var debug = function(step, detail) {
        try {
          post({ type: 'FRESHMAN_AUTH_DEBUG', step: step, detail: detail || {} });
        } catch (ignore) {}
      };
      var settled = false;
      var fail = function(message) {
        if (settled) return;
        settled = true;
        post({ type: 'FRESHMAN_AUTH_FAIL', message: String(message || '') });
      };

      debug('SCRIPT_INJECTED', { href: String(window.location && window.location.href || '').split('?')[0] });

      window.alert = function(msg) {
        debug('WINDOW_ALERT', { msg: String(msg || '') });
        fail(msg || '신입생 전산망 인증 실패');
      };

      var retryCount = 0;
      var collYyWaitCount = 0;
      var checkReady = setInterval(function() {
        retryCount++;
        var form = null;
        try {
          var frame = application && application.mainframe && application.mainframe.ChildFrame
            && application.mainframe.ChildFrame.form && application.mainframe.ChildFrame.form.div_Work;
          form = frame ? (frame.form || frame) : null;
        } catch (e) {
          form = null;
        }

        if (form && form.DS_COND && typeof form.preLoginChk === 'function') {
          if (typeof form.DS_COND.get === 'function') {
            var currentCollYy = '';
            try {
              currentCollYy = String(form.DS_COND.get('collYy') || '').trim();
            } catch (e) {
              currentCollYy = '';
            }
            if (!currentCollYy) {
              collYyWaitCount++;
              if (collYyWaitCount < 25) {
                return;
              }
              var now = new Date();
              var fallbackYear = String(now.getMonth() + 1 >= 11 ? now.getFullYear() + 1 : now.getFullYear());
              form.DS_COND.set('collYy', fallbackYear);
            }
          }

          clearInterval(checkReady);
          debug('FORM_FOUND', {
            retryCount: retryCount,
            collYyWaitCount: collYyWaitCount,
            hasUtilsAlert: !!(form.utils && typeof form.utils.alert === 'function'),
            hasCommTxCb: typeof form._commTransactionCallback === 'function',
            hasPopupError: !!(form.popup && form.popup.error && typeof form.popup.error.open === 'function'),
            hasFnCallback: typeof form.fn_callBack === 'function'
          });
          try {
            form.DS_COND.set('j_id', CRED.examNo);
            form.DS_COND.set('nm', CRED.name);
            form.DS_COND.set('birthDt', CRED.birthDate);

            if (form.utils && typeof form.utils.alert === 'function') {
              var originalUtilsAlert = form.utils.alert;
              form.utils.alert = function(msg) {
                debug('UTILS_ALERT', { msg: String(msg || '') });
                fail(msg || '신입생 전산망 인증 실패');
                try {
                  return originalUtilsAlert.apply(this, arguments);
                } catch (ignore) {}
              };
            }

            if (form.popup && form.popup.error && typeof form.popup.error.open === 'function') {
              var originalPopupErrorOpen = form.popup.error.open;
              form.popup.error.open = function(arg) {
                var errMsg = arg && arg.errorMsg ? arg.errorMsg : '신입생 전산망 인증 실패';
                debug('POPUP_ERROR_OPEN', { errMsg: String(errMsg) });
                fail(errMsg);
                try {
                  return originalPopupErrorOpen.apply(this, arguments);
                } catch (ignore) {}
              };
            }

            if (typeof form._commTransactionCallback === 'function') {
              var originalCommTxCb = form._commTransactionCallback;
              form._commTransactionCallback = function(svcId, errCode, errMsg) {
                debug('COMM_TX_CB', { svcId: String(svcId || ''), errCode: errCode, errMsg: String(errMsg || '') });
                if (typeof errCode === 'number' && errCode < 0) {
                  fail(errMsg && errMsg !== 'FAILED' ? errMsg : '신입생 전산망 인증에 실패했습니다.');
                  return;
                }
                return originalCommTxCb.apply(this, arguments);
              };
            }

            // 성공 후 /nx 리다이렉트로 postMessage 와 경합하지 않도록 차단한다.
            form.afterLogin = function() {};

            var originalLoginSuccess = form.loginSuccess;
            form.loginSuccess = function() {
              var result = typeof originalLoginSuccess === 'function'
                ? originalLoginSuccess.apply(this, arguments)
                : undefined;
              debug('LOGIN_SUCCESS', { result: result });
              if (result === 1 && !settled) {
                settled = true;
                try {
                  var ds = application.gds_viewSession;
                  post({
                    type: 'FRESHMAN_AUTH_SUCCESS',
                    data: {
                      userNm: ds.getColumn(0, 'userNm'),
                      persNo: ds.getColumn(0, 'persNo'),
                      deptNm: ds.getColumn(0, 'deptNm'),
                      deptTtNm: ds.getColumn(0, 'deptTtNm'),
                      userGbn: ds.getColumn(0, 'userGbn'),
                      encStr: ds.getColumn(0, 'encStr')
                    }
                  });
                } catch (e) {
                  settled = false;
                  fail('신입생 전산망 세션 정보를 읽지 못했습니다.');
                }
              }
              return result;
            };

            if (typeof form.fn_callBack === 'function') {
              var originalCallBack = form.fn_callBack;
              form.fn_callBack = function(svcId) {
                debug('FN_CALLBACK', { svcId: String(svcId || '') });
                var ret = originalCallBack.apply(this, arguments);
                if (svcId === 'j_login' && !settled) {
                  var ok = typeof form.loginSuccess === 'function' ? form.loginSuccess() : 0;
                  if (ok !== 1) {
                    fail('신입생 전산망 인증에 실패했습니다.');
                  }
                }
                return ret;
              };
            }

            debug('CALL_PRE_LOGIN_CHK', {});
            form.preLoginChk();
          } catch (e) {
            debug('PRE_LOGIN_CHK_THROW', { message: String(e && e.message || e || '') });
            fail('신입생 전산망 로그인 요청에 실패했습니다.');
          }
          return;
        }

        if (retryCount % 10 === 0) {
          var divWorkObj = null;
          try {
            divWorkObj = application && application.mainframe && application.mainframe.ChildFrame
              && application.mainframe.ChildFrame.form && application.mainframe.ChildFrame.form.div_Work;
          } catch (ignore) {}
          debug('WAIT_FORM', {
            retryCount: retryCount,
            hasApp: typeof application !== 'undefined',
            hasMainframe: !!(typeof application !== 'undefined' && application && application.mainframe),
            hasChildFrame: !!(typeof application !== 'undefined' && application && application.mainframe && application.mainframe.ChildFrame),
            hasDivWork: !!divWorkObj,
            hasFormDSCond: !!(form && form.DS_COND),
            hasPreLoginChk: !!(form && typeof form.preLoginChk === 'function')
          });
        }

        if (retryCount > 100) {
          clearInterval(checkReady);
          fail('신입생 전산망 폼 준비 시간 초과');
        }
      }, 200);
    })();
    true;
  `;
}

export type FreshmanAuthMessageResult =
  | { ok: true; data: FreshmanAuthData }
  | { ok: false; message: string };

const DEFAULT_FAIL_MESSAGE = '신입생 전산망 인증에 실패했습니다.';

const asString = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * 웹뷰가 보낸 FRESHMAN_AUTH_* 메시지를 검증/정제한다.
 * 페이지가 임의로 넣은 필드는 버리고, 요청한 examNo는 앱이 기억하는 값으로 채운다.
 */
export function parseFreshmanAuthMessage(
  msg: any,
  expectedExamNo: string,
): FreshmanAuthMessageResult | null {
  if (!msg || typeof msg !== 'object') return null;

  if (msg.type === 'FRESHMAN_AUTH_FAIL') {
    const text = asString(msg.message).slice(0, MAX_ALERT_MESSAGE_LENGTH).trim();
    return { ok: false, message: text || DEFAULT_FAIL_MESSAGE };
  }

  if (msg.type === 'FRESHMAN_AUTH_SUCCESS') {
    const d = msg.data;
    if (!d || typeof d !== 'object') return { ok: false, message: DEFAULT_FAIL_MESSAGE };
    const data: FreshmanAuthData = {
      userNm: asString(d.userNm),
      persNo: asString(d.persNo),
      deptNm: asString(d.deptNm),
      deptTtNm: asString(d.deptTtNm),
      userGbn: asString(d.userGbn),
      encStr: asString(d.encStr),
      examNo: expectedExamNo,
    };
    // 세션 정보가 비어 있으면 성공으로 취급하지 않는다.
    if (!data.userNm && !data.persNo) return { ok: false, message: DEFAULT_FAIL_MESSAGE };
    return { ok: true, data };
  }

  return null;
}
