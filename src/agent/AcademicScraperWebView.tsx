import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { PortalCredentials } from './secureStore';

const PORTAL_LOGIN_URL = 'https://portal.inu.ac.kr:444/enview/user/login.face';
const ERP_SSO_URL = 'http://erp.inu.ac.kr:8881/com/SsoCtr/initPageWork.do?loginGbn=sso';
const SCRAPE_TIMEOUT_MS = 35000;
const MIN_SCRAPER_VIEW_SIZE = 1;
const SESSION_CAPTURE = `
  (function() {
    window.__erpMetadata = {};
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body) {
      if (typeof body === 'string' && body.indexOf('WMONID=') >= 0) {
        body.split('Dataset:')[0].split(String.fromCharCode(30)).forEach(function(part) {
          var i = part.indexOf('=');
          if (i > 0) window.__erpMetadata[part.slice(0,i)] = part.slice(i+1);
        });
      }
      return send.apply(this, arguments);
    };
  })(); true;
`;

export interface ErpActionOptions {
  creds: PortalCredentials;
  actionId?: string;
  target?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    params?: Record<string, string | number | boolean>;
    bodyTemplate?: any;
    body?: any;
  };
}

type ScrapeResolver = {
  resolve: (data: string) => void;
  reject: (err: Error) => void;
};

let activeScrapePromise: Promise<string> | null = null;
let activeResolvers: ScrapeResolver[] = [];
let activeCreds: PortalCredentials | null = null;
let activeOptions: ErpActionOptions | null = null;
let activeTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
let triggerComponentScrape: ((options: ErpActionOptions) => void) | null = null;
let resolveScraperMount: (() => void) | null = null;

function waitForScraperMount(timeoutMs = 15000): Promise<void> {
  if (triggerComponentScrape) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (resolveScraperMount === onMounted) resolveScraperMount = null;
      reject(new Error('포털 시스템 조회 준비 시간이 초과되었습니다.'));
    }, timeoutMs);

    const onMounted = () => {
      clearTimeout(timeout);
      resolve();
    };
    resolveScraperMount = onMounted;
  });
}

export const AcademicScraperManager = {
  executeScrape(creds: PortalCredentials): Promise<string> {
    return this.executeErpAction({ creds, actionId: 'PORTAL_GET_ACADEMIC_RECORD' });
  },

  executeErpAction(options: ErpActionOptions): Promise<string> {
    const { creds, actionId } = options;

    // 동일한 학번 및 액션에 대해 이미 진행 중인 Promise가 있으면 재사용
    if (activeScrapePromise && activeCreds?.studentId === creds.studentId && activeOptions?.actionId === actionId) {
      console.log('[AcademicScraper] Reusing in-flight scrape promise for student:', creds.studentId, 'action:', actionId);
      return activeScrapePromise;
    }

    // 다른 요청인 경우 이전 작업 정리
    if (activeResolvers.length > 0) {
      activeResolvers.forEach((r) => r.reject(new Error('새로운 ERP 조회 요청으로 이전 작업이 취소되었습니다.')));
      activeResolvers = [];
      if (activeTimeoutTimer) {
        clearTimeout(activeTimeoutTimer);
        activeTimeoutTimer = null;
      }
    }

    activeCreds = creds;
    activeOptions = options;
    activeScrapePromise = new Promise<string>((resolve, reject) => {
      activeResolvers.push({ resolve, reject });

      waitForScraperMount()
        .then(() => {
          if (activeCreds?.studentId !== creds.studentId) return;
          triggerComponentScrape?.(options);

          if (activeTimeoutTimer) clearTimeout(activeTimeoutTimer);
          activeTimeoutTimer = setTimeout(() => {
            if (activeCreds?.studentId === creds.studentId && activeResolvers.length > 0) {
              const err = new Error('포털 ERP 정보 조회 시간 초과 (35초)');
              activeResolvers.forEach((r) => r.reject(err));
              activeResolvers = [];
              activeScrapePromise = null;
              activeCreds = null;
              activeOptions = null;
            }
          }, SCRAPE_TIMEOUT_MS);
        })
        .catch((error: Error) => {
          if (activeCreds?.studentId === creds.studentId) {
            activeResolvers.forEach((r) => r.reject(error));
            activeResolvers = [];
            activeScrapePromise = null;
            activeCreds = null;
            activeOptions = null;
          }
        });
    });

    return activeScrapePromise;
  },
};

export const AcademicScraperWebView: React.FC = () => {
  const webViewRef = useRef<WebView>(null);
  const [targetUrl, setTargetUrl] = useState<string>('about:blank');
  const credsRef = useRef<PortalCredentials | null>(null);
  const optionsRef = useRef<ErpActionOptions | null>(null);
  const stepRef = useRef<'IDLE' | 'LOGIN' | 'ERP_REDIRECT' | 'ERP_QUERY'>('IDLE');

  const finishScrapeSuccess = useCallback((result: string) => {
    if (activeTimeoutTimer) {
      clearTimeout(activeTimeoutTimer);
      activeTimeoutTimer = null;
    }
    const resolvers = [...activeResolvers];
    activeResolvers = [];
    activeScrapePromise = null;
    activeCreds = null;
    activeOptions = null;
    resolvers.forEach((r) => r.resolve(result));

    stepRef.current = 'IDLE';
    credsRef.current = null;
    optionsRef.current = null;
    setTargetUrl('about:blank');
  }, []);

  const finishScrapeError = useCallback((err: Error) => {
    if (activeTimeoutTimer) {
      clearTimeout(activeTimeoutTimer);
      activeTimeoutTimer = null;
    }
    const resolvers = [...activeResolvers];
    activeResolvers = [];
    activeScrapePromise = null;
    activeCreds = null;
    activeOptions = null;
    resolvers.forEach((r) => r.reject(err));

    stepRef.current = 'IDLE';
    credsRef.current = null;
    optionsRef.current = null;
    setTargetUrl('about:blank');
  }, []);

  // Register synchronously after the native tree commits, before the hosted
  // portal can issue its first bridge request.
  useLayoutEffect(() => {
    triggerComponentScrape = (options: ErpActionOptions) => {
      credsRef.current = options.creds;
      optionsRef.current = options;
      stepRef.current = 'LOGIN';
      console.log('[AcademicScraper] Starting scraper for student:', options.creds.studentId, 'action:', options.actionId || 'DEFAULT');
      setTargetUrl(PORTAL_LOGIN_URL);
    };
    resolveScraperMount?.();
    resolveScraperMount = null;

    return () => {
      triggerComponentScrape = null;
      if (activeTimeoutTimer) {
        clearTimeout(activeTimeoutTimer);
        activeTimeoutTimer = null;
      }
      if (activeResolvers.length > 0) {
        activeResolvers.forEach((r) => r.reject(new Error('스크레이퍼 언마운트됨')));
        activeResolvers = [];
        activeScrapePromise = null;
        activeCreds = null;
        activeOptions = null;
      }
    };
  }, []);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    const raw = event.nativeEvent.data;
    try {
      const msg = JSON.parse(raw);
      console.log('[AcademicScraper] Received message type:', msg?.type);

      if (msg.type === 'PORTAL_READY') {
        if (stepRef.current !== 'LOGIN' || !credsRef.current) return;
        if (typeof msg.studentId === 'string' && msg.studentId) credsRef.current = {...credsRef.current, studentId: msg.studentId};
        stepRef.current = 'ERP_REDIRECT';
        setTargetUrl(ERP_SSO_URL);
      } else if (msg.type === 'ALERT') {
        const text = String(msg.message || '');
        console.warn('[AcademicScraper] Web alert detected:', text);
        if (text.includes('비밀번호') || text.includes('아이디') || text.includes('오류') || text.includes('틀렸습니다') || text.includes('휴면')) {
          finishScrapeError(new Error(text || '포털 로그인에 실패했습니다.'));
        }
      } else if (msg.type === 'ACADEMIC_RESULT') {
        console.log('[AcademicScraper] Academic data successfully extracted, length:', msg.data?.length);
        finishScrapeSuccess(msg.data);
      } else if (msg.type === 'ERROR') {
        console.warn('[AcademicScraper] Scraper execution error:', msg.message);
        finishScrapeError(new Error(msg.message || 'ERP 조회 중 오류 발생'));
      }
    } catch {
      // Ignored non-json message
    }
  }, [finishScrapeError, finishScrapeSuccess]);

  const handleLoadEnd = useCallback(() => {
    if (stepRef.current === 'IDLE' || !credsRef.current) return;

    if (stepRef.current === 'LOGIN') {
      const { studentId, password } = credsRef.current;
      console.log('[AcademicScraper] Injecting login script at:', targetUrl);

      const loginScript = `
        (function() {
          window.alert = function(msg) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ALERT', message: msg }));
          };

          var checkLogin = function() {
            var idInput = document.getElementById('id') || document.querySelector('input[name="userIdI"]');
            var pwInput = document.getElementById('pw') || document.querySelector('input[name="passwordI"]');

            if (idInput && pwInput) {
              idInput.value = ${JSON.stringify(studentId)};
              pwInput.value = ${JSON.stringify(password)};

              setTimeout(function() {
                if (typeof enviewLogin === 'function') {
                  enviewLogin();
                } else {
                  var form = document.getElementById('LoginForm');
                  if (form) form.submit();
                }
              }, 400);
            }
          };

          if (document.readyState === 'complete' || document.readyState === 'interactive') {
            checkLogin();
          } else {
            window.addEventListener('DOMContentLoaded', checkLogin);
          }
        })();
        true;
      `;
      webViewRef.current?.injectJavaScript(loginScript);
    }
  }, [targetUrl]);

  const handleNavigationStateChange = useCallback((navState: { url: string; loading: boolean }) => {
    const { url, loading } = navState;
    if (stepRef.current === 'IDLE') return;

    console.log('[AcademicScraper] Nav state change:', url, 'loading:', loading);

    // 1단계 -> 2단계: 포털 로그인 후 메인 또는 enpass 리다이렉트 완료 감지
    if (stepRef.current === 'LOGIN') {
      if (
        url.includes('/enview/portal/') ||
        url.includes('/main/main.face') ||
        url.includes('portal.face')
      ) {
        console.log('[AcademicScraper] Portal login succeeded. Navigating to ERP SSO...');
        if (!loading) webViewRef.current?.injectJavaScript(`window.ReactNativeWebView.postMessage(JSON.stringify({type:'PORTAL_READY', studentId: window.temp_user_id || ''})); true;`);
      }
    }

    // 2단계 -> 3단계: ERP 메인 도달 감지
    if (stepRef.current === 'ERP_REDIRECT') {
      // SSO can temporarily load portal.inu.ac.kr:7780 with the ERP URL in
      // its query string. A substring match mistakes that blocked redirect
      // page for an ERP document, where document.cookie is inaccessible.
      let isHttpsErpDocument = false;
      try {
        const currentUrl = new URL(url);
        isHttpsErpDocument = currentUrl.hostname === 'erp.inu.ac.kr'
          && (currentUrl.port === '8443' || currentUrl.pathname.includes('/com/SsoCtr/') || currentUrl.pathname.startsWith('/nx/'));
      } catch {
        // Keep waiting for a valid ERP navigation.
      }

      if (isHttpsErpDocument) {
        if (!loading) {
          console.log('[AcademicScraper] ERP session reached. Injecting ERP query script...');
          stepRef.current = 'ERP_QUERY';
          const studentId = credsRef.current?.studentId || '';

          const queryScript = `
            (async function() {
              try {
                var metadata = window.__erpMetadata || {};
                var wmonid = metadata.WMONID || '';
                try {
                  var m = document.cookie.match(/WMONID=([^;]+)/);
                  if (m) wmonid = m[1];
                } catch (cookieError) {
                  // Some transition documents deny cookie reads.
                }
                if (!wmonid && window.WMONID) wmonid = window.WMONID;
                if (!wmonid && window.wmonid) wmonid = window.wmonid;
                try { if (!wmonid) wmonid = sessionStorage.getItem('WMONID') || localStorage.getItem('WMONID') || ''; } catch (_) {}
                if (!wmonid) wmonid = 'wmon_mobile';

                var RS = String.fromCharCode(30);
                var US = String.fromCharCode(31);
                var NULL = String.fromCharCode(3);
                var base = 'SSV:utf-8' + RS + 'WMONID=' + wmonid + RS + '_ba_exist=' + (metadata._ba_exist || 'true') + RS + 'login_domain=' + (metadata.login_domain || 'inu.ac.kr') + RS + 'requestTimeStr=' + Date.now() + RS;
                ['_clck', '_clsk'].forEach(function(key) { if (metadata[key]) base += key + '=' + metadata[key] + RS; });

                var actionId = ${JSON.stringify(optionsRef.current?.actionId || 'PORTAL_GET_ACADEMIC_RECORD')};
                var target = ${JSON.stringify(optionsRef.current?.target || {})};

                if (actionId === 'PORTAL_GET_STUDENT_TIMETABLE' || (target && target.url && target.url.indexOf('findStdSukangAplyList') >= 0)) {
                  // 1. 메뉴 권한 확인
                  var menuId = (target && target.params && target.params.menuId) || 'M003150';
                  var pgmId = (target && target.params && target.params.pgmId) || 'P001416';
                  try {
                    await fetch('/com/PermCtr/findMenuGrdOne.do?menuId=' + menuId + '&pgmId=' + pgmId, {
                      method: 'POST',
                      headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'REQFOUNDATAION': 'nexacro' },
                      body: base + 'menuId=' + menuId + RS
                    });
                  } catch(e) {}

                  // 2. 현재 연도 및 학기 산출 (파라미터가 있으면 우선 사용, 없으면 현재 날짜 기준)
                  var now = new Date();
                  var currentYy = String((target && target.params && target.params.yy) || now.getFullYear());
                  var currentMonth = now.getMonth() + 1;
                  // 1학기: 10, 여름: 30, 2학기: 20, 겨울: 40
                  var defaultTm = (currentMonth >= 2 && currentMonth <= 6) ? '10' : (currentMonth >= 8 && currentMonth <= 12) ? '20' : (currentMonth === 7) ? '30' : '40';
                  var currentTmGbn = String((target && target.params && target.params.tmGbn) || defaultTm);

                  var body = 'SSV:utf-8' + RS +
                    'WMONID=' + wmonid + RS +
                    '_ba_exist=true' + RS +
                    'login_domain=inu.ac.kr' + RS +
                    'Dataset:DS_COND' + RS +
                    '_RowType_' + US + 'deptClsfCd' + US + 'yy' + US + 'tmGbn' + US + 'stuno' + US + 'korNm' + US + 'pageType' + RS +
                    'U' + US + '0000587' + US + currentYy + US + currentTmGbn + US + ${JSON.stringify(studentId)} + US + NULL + US + 'sukang' + RS +
                    'O' + US + NULL + US + NULL + US + NULL + US + NULL + US + NULL + US + NULL + RS;

                  var url = (target && target.url) || '/uni/cour/CorrCtr/findStdSukangAplyList.do';
                  if (url.indexOf('?') < 0) url += '?menuId=' + menuId + '&pgmId=' + pgmId;

                  var res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'REQFOUNDATAION': 'nexacro' },
                    body: body
                  });
                  var text = await res.text();
                  if (!res.ok) throw new Error('ERP 시간표 조회 HTTP 오류');

                  window.ReactNativeWebView.postMessage(JSON.stringify({
                    type: 'ACADEMIC_RESULT',
                    data: JSON.stringify({ actionId: actionId, ssv: text, yy: currentYy, tmGbn: currentTmGbn })
                  }));
                } else {
                  // 기본 학적 정보 조회 (PORTAL_GET_ACADEMIC_RECORD)
                  try {
                    await fetch('/com/PermCtr/findMenuGrdOne.do?menuId=M002043&pgmId=P001878', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'text/plain; charset=UTF-8',
                        'REQFOUNDATAION': 'nexacro',
                      },
                      body: 'SSV:utf-8' + RS + 'WMONID=' + wmonid + RS + '_ba_exist=true' + RS + 'login_domain=inu.ac.kr' + RS + 'menuId=M002043' + RS
                    });
                  } catch(e) {}

                  // 학적 기본 정보 조회
                  var body = 'SSV:utf-8' + RS +
                    'WMONID=' + wmonid + RS +
                    '_ba_exist=true' + RS +
                    'login_domain=inu.ac.kr' + RS +
                    'Dataset:DS_COND' + RS +
                    '_RowType_' + US + 'stuno' + US + 'korNm' + US + 'gbn' + US + 'colgGrscCd' + US + 'colgCd' + US + 'earnMintStom' + RS +
                    'U' + US + ${JSON.stringify(studentId)} + US + NULL + US + NULL + US + NULL + US + NULL + US + '1' + RS +
                    'O' + US + NULL + US + NULL + US + NULL + US + NULL + US + NULL + US + '1' + RS;

                  var res = await fetch('/uni/sreg/TsimCtr/findBaseSchregInfoOne.do?menuId=M002043&pgmId=P001878', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'text/plain; charset=UTF-8',
                      'REQFOUNDATAION': 'nexacro',
                    },
                    body: body
                  });

                  var text = await res.text();
                  if (!res.ok) throw new Error('ERP 학적 조회 HTTP 오류');
                  var base = 'SSV:utf-8' + RS + 'WMONID=' + wmonid + RS + '_ba_exist=' + (metadata._ba_exist || 'true') + RS + 'login_domain=' + (metadata.login_domain || 'inu.ac.kr') + RS + 'requestTimeStr=' + Date.now() + RS;
                  ['_clck', '_clsk'].forEach(function(key) { if (metadata[key]) base += key + '=' + metadata[key] + RS; });
                  async function codeRequest(path, body) {
                    var response = await fetch(path + '?menuId=M002043&pgmId=P001878', {
                      method: 'POST', credentials: 'include',
                      headers: {'Content-Type': 'text/plain; charset=UTF-8', 'REQFOUNDATAION': 'nexacro'}, body: body
                    });
                    if (!response.ok) throw new Error('ERP 코드 조회 실패');
                    return response.text();
                  }
                  var commonCodes = '', departments = {};
                  try {
                    commonCodes = await codeRequest('/com/CodeCtr/findCodeComboList.do', base +
                      'rpstCd=A0013|CA001|UB026|UB006|UB007|UB008|UB001|UB002|UB003|UB004|UB010' + RS +
                      'useYn=1|1|1|1|1|1|1|1|1|1|1' + RS + 'textMode=N|N|N|N|N|N|N|N|N|N|N' + RS +
                      'dataSet=DS_GEN_GBN|DS_NAT_GBN|DS_HY_SEQ_GBN|DS_CORS_GBN|DS_SCHREG_ST_GBN|DS_SCHREG_MOD_GBN|DS_ENTR_GBN|DS_ENTR_CLSF_GBN|DS_CAPA_IO_GBN|DS_SKIL_STD_GBN|DS_MIL_FINISH_GBN' + RS);
                  } catch (_) {}
                  try {
                    var xml = new DOMParser().parseFromString(await codeRequest('/uni/sreg/BaimCtr/findDeptCdList1.do', base), 'text/xml');
                    Array.from(xml.getElementsByTagName('Row')).forEach(function(row) {
                      var code = row.querySelector('Col[id="deptCd"]');
                      var name = row.querySelector('Col[id="deptNm"]');
                      if (code && name) departments[code.textContent.trim()] = name.textContent.trim();
                    });
                  } catch (_) {}
                  window.ReactNativeWebView.postMessage(JSON.stringify({
                    type: 'ACADEMIC_RESULT',
                    data: JSON.stringify({ actionId: actionId, ssv: text, commonCodes: commonCodes, departments: departments })
                  }));
                }
              } catch(err) {
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ERROR', message: err.message }));
              }
            })();
            true;
          `;

          setTimeout(() => {
            webViewRef.current?.injectJavaScript(queryScript);
          }, 1500);
        }
      }
    }
  }, []);

  return (
    <View style={styles.hiddenContainer} pointerEvents="none">
      <WebView
        ref={webViewRef}
        injectedJavaScriptBeforeContentLoaded={SESSION_CAPTURE}
        source={{ uri: targetUrl }}
        style={styles.hiddenWebView}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        sharedCookiesEnabled={true}
        thirdPartyCookiesEnabled={true}
        cacheEnabled={true}
        onMessage={handleMessage}
        onLoadEnd={handleLoadEnd}
        onNavigationStateChange={handleNavigationStateChange}
        userAgent="Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
      />
    </View>
  );
};

const styles = StyleSheet.create({
  hiddenContainer: {
    // Android may defer layout/loading for a zero-sized WebView. Keep it
    // invisible and offscreen, but give the SSO WebView a real render surface.
    width: MIN_SCRAPER_VIEW_SIZE,
    height: MIN_SCRAPER_VIEW_SIZE,
    position: 'absolute',
    top: -1000,
    left: -1000,
    opacity: 0,
  },
  hiddenWebView: {
    width: 1,
    height: 1,
  },
});
