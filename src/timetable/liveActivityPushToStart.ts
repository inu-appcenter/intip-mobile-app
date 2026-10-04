/**
 * iOS ActivityKit push-to-start 토큰을 서버에 등록한다.
 *
 * iOS는 Live Activity를 앱이 포그라운드일 때만 시작할 수 있다. 그래서 앱이 꺼져 있으면
 * 시간표 Live Activity가 뜨지 않았다. 서버(inu-portal-server)의 "수업 N분 전" 알림은 이
 * 토큰이 등록된 기기에 한해 일반 알림 대신 Live Activity 시작 푸시(같은 제목/본문의 alert
 * 포함)로 나간다 — `PUT /api/tokens/live-activity`.
 *
 * FCM으로 Live Activity를 보내려면 기기(FCM 토큰)와 ActivityKit 토큰을 한 메시지에 같이
 * 실어야 하므로 둘을 쌍으로 등록한다. 토큰은 iOS 17.2+에서만 발급된다.
 *
 * 앱의 시간표 Live Activity 설정(`TimetableStorage` settings.enabled)을 끄면 토큰을
 * 비워 등록을 해제한다 — 서버는 그 기기에 다시 일반 알림을 보낸다.
 *
 * 떠 있는 Activity마다의 업데이트 토큰도 등록한다(`PUT /api/tokens/live-activity/activities`).
 * 서버는 그 토큰으로 수업 시작 때 "수업 중"으로 갱신하고 수업이 끝나면 Activity를 끝낸다 — 앱이
 * 꺼져 있으면 끝난 수업의 Activity가 남아 다음 수업 것과 겹치기 때문이다. push-to-start로 시작된
 * Activity도 시스템이 앱을 백그라운드로 깨워 주므로 그때 토큰이 넘어간다.
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import messaging from '@react-native-firebase/messaging';
import { addPushToStartTokenListener } from 'expo-widgets';
import {
  addActivityPushTokenListener,
  finishBackgroundWork,
  type ActivityPushTokenEvent,
} from '../../modules/intip-live-activity-tokens';
import { API_BASE_URL } from '../config/env';
import { getValidAccessToken } from '../native/authTokens';
import { TimetableStorage } from './timetableStorage';

const STORAGE_KEY_REGISTERED = 'intip_live_activity_push_to_start_registered';

let latestStartToken: string | null = null;
/** 마지막으로 서버가 받아들인 `${fcmToken}|${startToken}` — 같은 쌍은 다시 보내지 않는다. */
let lastSentKey: string | null = null;
let registered: boolean | null = null;
/** 아직 서버에 못 보낸 Activity 업데이트 토큰 (activityId별 최신 값). */
const pendingActivityTokens = new Map<string, ActivityPushTokenEvent>();
let syncing: Promise<void> | null = null;
let resyncRequested = false;

async function setRegistered(value: boolean): Promise<void> {
  registered = value;
  try {
    await SecureStore.setItemAsync(STORAGE_KEY_REGISTERED, value ? '1' : '0');
  } catch {
    // 메모리 값만으로도 이번 실행 동안은 충분하다.
  }
}

/**
 * 서버가 이 기기에 수업 전 Live Activity를 push-to-start로 보내는 중인지.
 *
 * 그렇다면 앱은 UPCOMING Live Activity를 직접 시작하지 않는다 — 곧 서버 푸시가 또 하나를
 * 시작해 잠금화면에 두 개가 겹치기 때문이다. 콜드 스타트 직후 첫 등록이 끝나기 전에도
 * 맞게 답하도록 마지막 결과를 저장해 둔다.
 */
export async function isLiveActivityPushToStartRegistered(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  if (registered !== null) return registered;
  try {
    registered = (await SecureStore.getItemAsync(STORAGE_KEY_REGISTERED)) === '1';
  } catch {
    registered = false;
  }
  return registered;
}

async function putStartToken(fcmToken: string, startToken: string | null, accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/tokens/live-activity`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Auth: accessToken },
      body: JSON.stringify({ token: fcmToken, liveActivityStartToken: startToken }),
    });
    return res.ok;
  } catch (err) {
    console.warn('[liveActivityPushToStart] PUT /api/tokens/live-activity failed', err);
    return false;
  }
}

async function putActivityToken(
  fcmToken: string,
  event: ActivityPushTokenEvent,
  accessToken: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/tokens/live-activity/activities`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Auth: accessToken },
      body: JSON.stringify({
        token: fcmToken,
        activityId: event.activityId,
        pushToken: event.pushToken,
        props: event.props,
      }),
    });
    return res.ok;
  } catch (err) {
    console.warn('[liveActivityPushToStart] PUT /api/tokens/live-activity/activities failed', err);
    return false;
  }
}

async function syncStartToken(fcmToken: string, accessToken: string): Promise<void> {
  // 토큰을 아직 못 받았으면(iOS 17.2 미만 포함) 등록할 것이 없다.
  if (!latestStartToken) return;

  const { enabled } = await TimetableStorage.getSettings();
  const startToken = enabled ? latestStartToken : null;

  const key = `${fcmToken}|${startToken ?? ''}`;
  if (key === lastSentKey) return;

  if (await putStartToken(fcmToken, startToken, accessToken)) {
    lastSentKey = key;
    await setRegistered(startToken !== null);
  }
}

async function syncActivityTokens(fcmToken: string, accessToken: string): Promise<void> {
  if (pendingActivityTokens.size === 0) return;
  for (const [activityId, event] of [...pendingActivityTokens]) {
    if (await putActivityToken(fcmToken, event, accessToken)) {
      // 보내는 사이 같은 Activity의 토큰이 갱신됐으면 남겨 둔다.
      if (pendingActivityTokens.get(activityId) === event) pendingActivityTokens.delete(activityId);
    }
  }
  // push-to-start로 백그라운드 실행된 경우 네이티브가 실행 시간을 붙잡고 있다 — 다 보냈으면 돌려준다.
  if (pendingActivityTokens.size === 0) finishBackgroundWork();
}

async function doSync(): Promise<void> {
  if (!latestStartToken && pendingActivityTokens.size === 0) return;

  const fcmToken = await messaging().getToken().catch(() => null);
  if (!fcmToken) return;

  const accessToken = await getValidAccessToken();
  // 로그인 전이면 다음 기회(로그인 성공 / 포그라운드 복귀)에 다시 시도한다.
  if (!accessToken) return;

  await syncStartToken(fcmToken, accessToken);
  await syncActivityTokens(fcmToken, accessToken);
}

/**
 * 현재 push-to-start 토큰·설정과 아직 못 보낸 Activity 업데이트 토큰을 서버에 반영한다. 호출 시점:
 * 토큰 수신, 로그인 성공, 포그라운드 복귀, Live Activity 설정 변경. 바뀐 게 없으면 요청하지 않는다.
 */
export function syncLiveActivityStartToken(): Promise<void> {
  if (Platform.OS !== 'ios') return Promise.resolve();
  if (syncing) {
    // 진행 중인 요청은 이전 상태를 보고 있을 수 있으니 끝난 뒤 한 번 더 돈다.
    resyncRequested = true;
    return syncing;
  }
  syncing = doSync()
    .catch((err) => console.warn('[liveActivityPushToStart] sync failed', err))
    .finally(() => {
      syncing = null;
      if (resyncRequested) {
        resyncRequested = false;
        void syncLiveActivityStartToken();
      }
    });
  return syncing;
}

/**
 * push-to-start 토큰과 Activity별 업데이트 토큰 수신을 시작한다. 리스너를 붙여야 네이티브가 토큰
 * 관찰을 시작하고, 이미 발급된 토큰도 곧바로 한 번 전달된다. 반환값은 해제 함수.
 */
export function registerLiveActivityPushToStart(): () => void {
  if (Platform.OS !== 'ios') return () => {};
  const startSubscription = addPushToStartTokenListener(({ activityPushToStartToken }) => {
    latestStartToken = activityPushToStartToken;
    void syncLiveActivityStartToken();
  });
  const activitySubscription = addActivityPushTokenListener((event) => {
    if (event.name !== TimetableLiveActivityName) return;
    pendingActivityTokens.set(event.activityId, event);
    void syncLiveActivityStartToken();
  });
  return () => {
    startSubscription.remove();
    activitySubscription.remove();
  };
}

/** `createLiveActivity('TimetableLiveActivity', …)` 이름 (src/widgets/TimetableLiveActivity.tsx). */
const TimetableLiveActivityName = 'TimetableLiveActivity';
