import appCheck from '@react-native-firebase/app-check';

let initPromise: Promise<void> | null = null;

/**
 * Firebase App Check 초기화 (Android Play Integrity / Apple App Attest, 개발 빌드는 Debug 프로바이더).
 * 앱 부팅 시 1회 실행되며, 이후 호출에서는 동일 Promise 를 재사용한다.
 */
export function initializeAppCheck(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      const rnfbProvider = appCheck().newReactNativeFirebaseAppCheckProvider();
      rnfbProvider.configure({
        android: {
          provider: __DEV__ ? 'debug' : 'playIntegrity',
        },
        apple: {
          provider: __DEV__ ? 'debug' : 'appAttestWithDeviceCheckFallback',
        },
      });
      await appCheck().initializeAppCheck({
        provider: rnfbProvider,
        isTokenAutoRefreshEnabled: true,
      });
    } catch (err) {
      // 초기화 실패 시 다음 시도에서 재초기화할 수 있도록 캐시를 비운다.
      initPromise = null;
      console.warn('[AppCheck] initialize failed:', err instanceof Error ? err.message : String(err));
    }
  })();

  return initPromise;
}

/**
 * 신입생 인증 등 일회성 보호 엔드포인트용 Limited-Use App Check 토큰 발급.
 * 네이티브 토큰 발급에 실패하면 undefined 를 반환하며, 운영 환경(APPCHECK_ENABLED=true)에서는 서버가 401로 차단한다.
 */
export async function getFreshmanAppCheckToken(): Promise<string | undefined> {
  try {
    await initializeAppCheck();
    const result = await appCheck().getLimitedUseToken();
    return result?.token ? result.token : undefined;
  } catch (err) {
    console.warn('[AppCheck] getLimitedUseToken failed:', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}
