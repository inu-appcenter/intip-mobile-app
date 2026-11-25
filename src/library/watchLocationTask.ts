/**
 * 백그라운드 위치 태스크 등록. TaskManager.defineTask는 번들 평가 시점의 최상위
 * 부수효과여야 하므로 index.js에서 import 한다(React 트리 안에서는 늦다).
 *
 * 위치 값은 버린다. 콜백이 오는 김에 감시 tick을 한 번 더 당겨 실행할 뿐이고
 * (LocalWatchManager가 주기 단위로 중복 실행을 걸러냄), 실제 생존은 위치 업데이트가
 * 켜져 있다는 사실 자체로 보장된다 — backgroundKeepAlive.ts 참고.
 */
import * as TaskManager from 'expo-task-manager';
import { LIBRARY_WATCH_LOCATION_TASK } from './backgroundKeepAlive';

TaskManager.defineTask(LIBRARY_WATCH_LOCATION_TASK, async ({ error }) => {
  if (error) return;
  try {
    // 순환 import 방지: 콜백 시점에 지연 로드
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalWatchManager } = require('../agent/localWatchManager');
    await LocalWatchManager.tick();
  } catch (e) {
    console.warn('[WatchLocationTask] tick failed:', e);
  }
});
