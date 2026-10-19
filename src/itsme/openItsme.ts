/**
 * 잇츠미 링크를 실제로 연다 — 잇츠미 앱 쪽 버그를 피하는 순서로.
 *
 * ## Android: 런처 먼저, 딥링크는 그 다음
 *
 * 잇츠미가 꺼진 상태에서 첫 실행을 딥링크(VIEW 인텐트)로 하면 영구 검은 화면에
 * 멈춘다(issue #65, 잇츠미 자체 버그). 런처(MAIN 인텐트)로 먼저 띄우면 정상이고,
 * 그 뒤에 보낸 딥링크는 잇츠미가 큐에 넣었다가 PIN/생체 잠금이 풀리면 처리한다.
 * 그래서 `openApplication` 으로 띄우고 {@link ITSME_LINK_DELAY_MS} 뒤에 링크를
 * 보낸다. 이미 떠 있던 잇츠미라면 런처 인텐트는 앞으로 가져오기만 해서 무해하다.
 *
 * 두 번째 `openURL` 은 우리 앱이 이미 백그라운드로 간 뒤에 나간다. Android 의
 * 백그라운드 액티비티 실행 제한에는 방금 액티비티를 띄운 앱에 대한 유예 시간이
 * 있어 통과하지만, 사용자가 그 사이 홈 버튼을 누르면 막힐 수 있다 — 그때는
 * 잇츠미가 런처 화면에 남는다(최악이어도 앱은 열린다).
 *
 * `openApplication` 이 던지면 미설치(또는 패키지 가시성 누락 — `<queries>` 는
 * `plugins/withItsmeQueries.js`)로 보고 Play 스토어로 보낸다.
 *
 * ## iOS
 *
 * 다른 앱을 런처 방식으로 띄울 API 가 없고 콜드 버그도 미검증이라, Universal
 * Link 로 그대로 연다. 미설치면 Safari 가 link.itsme.co.kr 페이지를 연다.
 */
import { openApplication } from 'expo-intent-launcher';
import { Linking, Platform } from 'react-native';

import { ITSME_ANDROID_PACKAGE } from './itsmeLink';

/**
 * 런처 실행 후 딥링크를 보내기까지의 간격. 잇츠미 액티비티가 런처 인텐트로
 * 만들어진 뒤여야 하니 너무 짧으면 콜드 버그를 다시 밟고, 백그라운드 실행
 * 유예(약 10초) 안이어야 하니 너무 길어서도 안 된다.
 */
export const ITSME_LINK_DELAY_MS = 1500;

const PLAY_STORE_MARKET_URL = `market://details?id=${ITSME_ANDROID_PACKAGE}`;
const PLAY_STORE_WEB_URL = `https://play.google.com/store/apps/details?id=${ITSME_ANDROID_PACKAGE}`;

async function openPlayStore(): Promise<void> {
  try {
    await Linking.openURL(PLAY_STORE_MARKET_URL);
  } catch {
    await Linking.openURL(PLAY_STORE_WEB_URL).catch(() => {});
  }
}

/**
 * 잇츠미 링크(`https://link.itsme.co.kr/…`, `itsme://…`)를 연다. 실패해도
 * 던지지 않는다 — WebView 내비게이션 가드에서 불리는 fire-and-forget 경로다.
 */
export async function openItsmeLink(url: string): Promise<void> {
  if (Platform.OS !== 'android') {
    await Linking.openURL(url).catch(() => {});
    return;
  }

  try {
    openApplication(ITSME_ANDROID_PACKAGE);
  } catch {
    await openPlayStore();
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ITSME_LINK_DELAY_MS));
  await Linking.openURL(url).catch(() => {});
}
