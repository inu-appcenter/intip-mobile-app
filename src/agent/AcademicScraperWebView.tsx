import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { PortalCredentials } from './secureStore';

const PORTAL_LOGIN_URL = 'https://portal.inu.ac.kr:444/enview/user/login.face';
const ERP_SSO_URL = 'http://erp.inu.ac.kr:8881/com/SsoCtr/initPageWork.do?loginGbn=sso';
const SCRAPE_TIMEOUT_MS = 35000;
const MIN_SCRAPER_VIEW_SIZE = 1;

type ScrapeResolver = {
  resolve: (data: string) => void;
  reject: (err: Error) => void;
  creds: PortalCredentials;
};

let activeScrape: ScrapeResolver | null = null;
let triggerComponentScrape: ((creds: PortalCredentials) => void) | null = null;
let resolveScraperMount: (() => void) | null = null;

function waitForScraperMount(timeoutMs = 15000): Promise<void> {
  if (triggerComponentScrape) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (resolveScraperMount === onMounted) resolveScraperMount = null;
      reject(new Error('학적 조회 준비 시간이 초과되었습니다.'));
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
    if (activeScrape) {
      activeScrape.reject(new Error('다른 학적 조회 작업이 진행 중입니다.'));
      activeScrape = null;
    }

    return new Promise((resolve, reject) => {
      activeScrape = { resolve, reject, creds };

      // The root WebView can receive a chat request before this hidden WebView
      // has committed its first effect. Queue the scrape briefly instead of
      // incorrectly treating a linked account as unavailable.
      waitForScraperMount()
        .then(() => {
          if (activeScrape?.creds !== creds) return;
          triggerComponentScrape?.(creds);

          // The actual ERP timeout starts only after the hidden WebView is
          // available. Otherwise a slow React root mount steals time from an
          // otherwise valid portal SSO request.
          setTimeout(() => {
            if (activeScrape?.creds === creds) {
              activeScrape.reject(new Error('학적 정보 조회 시간 초과 (35초)'));
              activeScrape = null;
            }
          }, SCRAPE_TIMEOUT_MS);
        })
        .catch((error: Error) => {
          if (activeScrape?.creds === creds) {
            activeScrape.reject(error);
            activeScrape = null;
          }
        });

    });
  },
};

export const AcademicScraperWebView: React.FC = () => {
  const webViewRef = useRef<WebView>(null);
  const [targetUrl, setTargetUrl] = useState<string>('about:blank');
  const credsRef = useRef<PortalCredentials | null>(null);
  const stepRef = useRef<'IDLE' | 'LOGIN' | 'ERP_REDIRECT' | 'ERP_QUERY'>('IDLE');

  const finishScrapeSuccess = useCallback((result: string) => {
    if (activeScrape) {
      activeScrape.resolve(result);
      activeScrape = null;
    }
    stepRef.current = 'IDLE';
    credsRef.current = null;
    setTargetUrl('about:blank');
  }, []);

  const finishScrapeError = useCallback((err: Error) => {
    if (activeScrape) {
      activeScrape.reject(err);
      activeScrape = null;
    }
    stepRef.current = 'IDLE';
    credsRef.current = null;
    setTargetUrl('about:blank');
  }, []);

  // Register synchronously after the native tree commits, before the hosted
  // portal can issue its first bridge request.
  useLayoutEffect(() => {
    triggerComponentScrape = (creds: PortalCredentials) => {
      credsRef.current = creds;
      stepRef.current = 'LOGIN';
      console.log('[AcademicScraper] Starting scraper for student:', creds.studentId);
      setTargetUrl(PORTAL_LOGIN_URL);
    };
    resolveScraperMount?.();
    resolveScraperMount = null;

    return () => {
      triggerComponentScrape = null;
      if (activeScrape) {
        activeScrape.reject(new Error('스크레이퍼 언마운트됨'));
        activeScrape = null;
      }
    };
  }, []);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    const raw = event.nativeEvent.data;
    try {
      const msg = JSON.parse(raw);
      console.log('[AcademicScraper] Received message type:', msg?.type);

      if (msg.type === 'ALERT') {
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
        url.includes('/enpass/login') ||
        url.includes('enpassLoginProcess.face') ||
        url.includes('/enview/portal/') ||
        url.includes('/main/main.face') ||
        url.includes('portal.face')
      ) {
        console.log('[AcademicScraper] Portal login succeeded. Navigating to ERP SSO...');
        stepRef.current = 'ERP_REDIRECT';
        setTimeout(() => {
          setTargetUrl(ERP_SSO_URL);
        }, 500);
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
        isHttpsErpDocument = currentUrl.protocol === 'https:'
          && currentUrl.hostname === 'erp.inu.ac.kr';
      } catch {
        // Keep waiting for a valid ERP navigation.
      }

      if (isHttpsErpDocument) {
        if (!loading) {
          console.log('[AcademicScraper] ERP session reached. Injecting academic query script...');
          stepRef.current = 'ERP_QUERY';
          const studentId = credsRef.current?.studentId || '';

          const queryScript = `
            (async function() {
              try {
                var wmonid = '';
                try {
                  var m = document.cookie.match(/WMONID=([^;]+)/);
                  if (m) wmonid = m[1];
                } catch (cookieError) {
                  // Some transition documents deny cookie reads. The ERP
                  // request still accepts its default WMONID fallback below.
                }
                if (!wmonid && window.WMONID) wmonid = window.WMONID;
                if (!wmonid) wmonid = 'wmon_mobile';

                var RS = String.fromCharCode(30);
                var US = String.fromCharCode(31);
                var NULL = String.fromCharCode(3);

                // 메뉴 권한 사전 확인
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
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ACADEMIC_RESULT', data: text }));
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
