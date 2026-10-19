/**
 * 잇츠미(itsme) — 인천대 학식당 식권 결제 앱 — 의 딥링크 스펙과 학식당 storeId.
 *
 * 의존성 없는 순수 모듈(상수 + URL 판별/생성)이라 네이티브 모듈 없이 테스트된다.
 * 실제로 여는 쪽은 `openItsme.ts`.
 *
 * 스펙 출처: issue #65 (공개 매니페스트 정적 분석 + 실기기 검증, Android 기준).
 * - App Link `https://link.itsme.co.kr/store?storeId=<ID>&cornerId=<ID?>` 가
 *   특정 학식당 화면으로 바로 간다. `store` 타입은 https App Link 에서만
 *   파싱된다 — 커스텀 스킴(`itsme://`)에는 없다.
 * - storeId 는 잇츠미 서버 데이터라 바뀔 수 있다. 공식 연동 전까지는 여기
 *   한 곳에서만 관리한다.
 */

/** 잇츠미 Android 패키지명. `plugins/withItsmeQueries.js` 의 값과 맞춘다. */
export const ITSME_ANDROID_PACKAGE = 'id.itsme.mobile';

/** 잇츠미가 App Link 로 검증해 둔 호스트. */
export const ITSME_LINK_HOST = 'link.itsme.co.kr';

/**
 * 학식당 이름 → 잇츠미 storeId. 키는 inu-portal-web 의 식당 이름
 * (`resources/strings/cafeterias.tsx`) 그대로다 — 웹·위젯이 쓰는 이름과 같다.
 * `2기숙사 식당` 은 잇츠미에 매장이 없다.
 */
export const ITSME_STORE_IDS: Readonly<Record<string, string>> = {
  학생식당: '08db54d2-e344-4455-ae89-b73e7958d08a', // 11호관 1층
  '2호관(교직원)식당': '72defebb-cd42-4fcc-9a68-8dff8e1c50f3', // 2호관 2층
  제1기숙사식당: '623f18a9-b6f9-4abb-b350-36f85f076703', // 18-1호관 1층
  '27호관식당': '93ced8fe-ee05-424d-9f49-f2e2f423f263', // 제2공동 실습관 4층
  사범대식당: 'fb2c621a-0696-4a6f-96f0-121529c7dc70', // 별관 A동 지하 1층
};

/** 잇츠미의 특정 학식당 화면으로 가는 App Link. */
export function itsmeStoreUrl(storeId: string, cornerId?: string): string {
  const params = new URLSearchParams({ storeId });
  if (cornerId) params.set('cornerId', cornerId);
  return `https://${ITSME_LINK_HOST}/store?${params.toString()}`;
}

/** 학식당 이름으로 App Link 를 만든다. 잇츠미에 없는 식당이면 `null`. */
export function itsmeStoreUrlFor(cafeteriaName: string): string | null {
  const storeId = ITSME_STORE_IDS[cafeteriaName];
  return storeId ? itsmeStoreUrl(storeId) : null;
}

/** 잇츠미로 가는 링크(`https://link.itsme.co.kr/…` 또는 `itsme://…`)인지. */
export function isItsmeLink(url: string): boolean {
  if (typeof url !== 'string') return false;
  if (/^itsme:\/\//i.test(url)) return true;
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && parsed.host === ITSME_LINK_HOST;
  } catch {
    return false;
  }
}
