/**
 * iOS 백그라운드 생존(keep-alive) — 도서관 빈자리 감시 전용.
 *
 * iOS는 앱이 백그라운드로 가면 수 초 안에 프로세스를 suspend 시켜 JS 타이머
 * (setInterval 폴링)가 멈춘다. 예외 중 하나가 "백그라운드 위치 업데이트"다:
 * `allowsBackgroundLocationUpdates`가 켜진 표준 위치 서비스가 돌고 있는 동안은
 * 앱이 suspend 되지 않으므로 JS 스레드와 타이머가 계속 돈다. 그래서 감시 작업이
 * 하나라도 ACTIVE인 동안만 위치 업데이트를 켜 두고, 마지막 작업이 끝나면 끈다.
 *
 * - 위치 값 자체는 쓰지 않는다(저장·전송 없음). 앱을 깨워 두는 용도뿐이다.
 * - '항상 허용'이면 백그라운드에서도 조용히 유지된다. '앱 사용 중'만 허용돼도
 *   포그라운드에서 시작했다면 상태바 파란 표시(showsBackgroundLocationIndicator)와
 *   함께 백그라운드 유지가 된다. 둘 다 거부면 포그라운드에서만 감시된다.
 * - 사용자가 앱 스위처에서 앱을 강제 종료하면 iOS 정책상 어떤 방법으로도 이어갈 수 없다.
 *
 * Android는 notifee 포그라운드 서비스(LibraryOngoingService)가 같은 역할을 하므로 no-op.
 */
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

export const LIBRARY_WATCH_LOCATION_TASK = 'intip-library-watch-keepalive';

export type KeepAliveMode = 'ALWAYS' | 'WHEN_IN_USE' | 'NONE' | 'NOT_NEEDED';

let starting: Promise<KeepAliveMode> | null = null;

async function ensurePermission(): Promise<KeepAliveMode> {
  const fg = await Location.getForegroundPermissionsAsync();
  let fgGranted = fg.granted;
  if (!fgGranted && fg.canAskAgain) {
    fgGranted = (await Location.requestForegroundPermissionsAsync()).granted;
  }
  if (!fgGranted) return 'NONE';

  const bg = await Location.getBackgroundPermissionsAsync();
  if (bg.granted) return 'ALWAYS';
  if (bg.canAskAgain) {
    const req = await Location.requestBackgroundPermissionsAsync();
    if (req.granted) return 'ALWAYS';
  }
  return 'WHEN_IN_USE';
}

export const BackgroundKeepAlive = {
  /**
   * 감시가 시작될 때 호출. 권한 요청이 필요할 수 있으므로 앱이 포그라운드일 때
   * (= 사용자가 감시를 등록한 직후) 호출해야 한다.
   */
  async start(): Promise<KeepAliveMode> {
    if (Platform.OS !== 'ios') return 'NOT_NEEDED';
    if (starting) return starting;
    starting = (async () => {
      try {
        if (!(await TaskManager.isAvailableAsync())) return 'NONE';
        const mode = await ensurePermission();
        if (mode === 'NONE') return mode;
        if (await Location.hasStartedLocationUpdatesAsync(LIBRARY_WATCH_LOCATION_TASK)) return mode;
        await Location.startLocationUpdatesAsync(LIBRARY_WATCH_LOCATION_TASK, {
          // 정확도는 생존 여부와 무관. 배터리를 덜 쓰는 100m 단위로 충분하다.
          accuracy: Location.Accuracy.Balanced,
          distanceInterval: 50,
          // false가 핵심: true면 정지 상태에서 iOS가 업데이트를 멈추고 앱을 suspend 시킨다.
          pausesUpdatesAutomatically: false,
          activityType: Location.ActivityType.Other,
          showsBackgroundLocationIndicator: mode !== 'ALWAYS',
        });
        return mode;
      } catch (e) {
        console.warn('[BackgroundKeepAlive] start failed:', e);
        return 'NONE';
      } finally {
        starting = null;
      }
    })();
    return starting;
  },

  async stop(): Promise<void> {
    if (Platform.OS !== 'ios') return;
    try {
      if (await Location.hasStartedLocationUpdatesAsync(LIBRARY_WATCH_LOCATION_TASK)) {
        await Location.stopLocationUpdatesAsync(LIBRARY_WATCH_LOCATION_TASK);
      }
    } catch (e) {
      console.warn('[BackgroundKeepAlive] stop failed:', e);
    }
  },
};
