# FCM 알림 탭 라우팅 (push-tap deep link)

서버 이슈 #271 / PR #272(서버 레포, KimWash)로 FCM 페이로드에 `path`가
추가됨. 앱은 알림 탭 시 그 정보를 읽어
의도된 화면으로 이동해야 한다. 이 문서는 **현재 구현과 서버 스펙의 격차**와
그 격차를 메우는 구현 계획이다. 이 레포에 등록할 이슈는 [`issue.md`](./issue.md).

## 진행 상태

| 케이스 | 내용 | 상태 |
|---|---|---|
| G1 | 외부 URL 공지(학교 홈페이지) → 인앱 브라우저 | ✅ 완료 |
| G2 | 콜드스타트 딥링크 유실 (레이스) | ⬜ 예정 |
| G3 | 목적지 종류별 분기 (SPA / sub-page push / 외부) | ⬜ 예정 |
| G4 | 백그라운드 notifee 탭 유실 | ⬜ 예정 |
| G5 | Android 기본 알림 채널 | ⬜ 예정 |
| G6 | 공유 가이드 문서 오류 정정 | ⬜ 예정 (코드 변경 없음) |
| G7 | 같은 목적지 재탭 무시 | ⬜ 예정 |

**G1 구현 내역** (`feat/multi-webview-ux-improvement` 브랜치):
- `src/webview/constants.ts` — `PUSH_EXTERNAL_HOSTS = ['inu.ac.kr']`,
  서브도메인까지 포함하는 접미사 매칭.
- `src/push/navPath.ts` — candidate 추출을 `extractCandidate`로 분리.
- `src/push/navIntent.ts`(신규) — `resolveNavIntent`가 `{kind:'path'}` /
  `{kind:'external'}` 판별.
- `src/push/messaging.ts` — `getInitialNavPath`/`subscribeNotificationOpen`을
  `NavIntent` 반환/콜백으로 교체(`getInitialNavIntent`로 개명).
- `src/webview/WebViewHost.tsx`, `src/components/WebViewInstance.tsx` —
  `external` 인텐트를 `WebBrowser.openBrowserAsync()`(인앱 브라우저)로 처리.
- `src/push/__tests__/navIntent.test.ts`(신규) — allowlist/서브도메인/룩얼라이크
  거부 케이스.

G2 이후는 아직 코드 변경 없음 — 아래 "케이스별 해결 계획" 섹션이 각각의
설계다. 다음에 이어서 작업할 때는 G2부터.

## 서버가 보내는 것 (확정)

```jsonc
{
  "notification": { "title": "…", "body": "…" },   // 항상 동봉 (data-only 금지)
  "data": {
    "type": "GENERAL|CHAT|SCHOOL_NOTICE|DEPARTMENT|FRIEND",
    "path": "…",          // 아래 표
    "targetId": "…",
    "noticeId": "…",      // 공지 타입만
    "chatRoomId": "…"     // 채팅 타입만
  }
}
```

| type | path 형식 | 예시 |
|---|---|---|
| `SCHOOL_NOTICE`, `DEPARTMENT` | **외부 URL 원문** | `https://notice.inuportal.com/notice/123` |
| `GENERAL` (총학공지) | 포털 상대경로 + 쿼리 | `/councilnoticedetail?id=456` |
| `CHAT` | 포털 상대경로 | `/chat/789` |
| `FRIEND` | 포털 상대경로 | `/friend/list` (추후 `/friend/{id}`) |

> FCM `data`의 값은 **항상 문자열**이다. 숫자/객체로 오지 않는다고 가정하고 파싱한다.

## 현재 구현 (이미 있는 것)

배선은 이미 대부분 존재한다. 새로 만들 게 아니라 **고치고 채우는** 작업이다.

- `src/push/messaging.ts` — 권한 요청, 토큰(3회 재시도), 포그라운드 배너(notifee),
  `getInitialNavPath()`, `subscribeNotificationOpen()`, 백그라운드 핸들러 등록.
- `src/push/navPath.ts` — `data` → 포털 path 순수 변환 (`extractNavPath`).
- `src/webview/WebViewHost.tsx:253` — 콜드스타트 시 `getInitialNavPath()` 조회 →
  `initialNavPath` state → root 인스턴스에 prop 전달 (`:419`).
- `src/components/WebViewInstance.tsx:220-225` — root만 포그라운드 배너 + 탭 구독,
  `:401` `onLoadEnd`에서 대기 중인 딥링크 flush.

## 격차 / 결함

### G1. 공지 알림(외부 URL)이 통째로 버려진다 — **기능 미동작**
`extractNavPath`(`navPath.ts:16`)는 `u.host === PORTAL_HOST`가 아니면 `null`을
반환한다. 서버가 `SCHOOL_NOTICE`/`DEPARTMENT`에 보내는
`https://notice.inuportal.com/...`은 **전부 여기서 탈락**해 탭해도 아무 일이
일어나지 않는다. 알림 4종 중 2종이 죽어 있는 상태다.

### G2. 콜드스타트 딥링크 유실 — **레이스 버그**
`WebViewInstance.tsx:147`

```ts
const pendingNavRef = useRef<string | null>(initialNavPath ?? null);
```

`useRef`의 인자는 **최초 마운트 때만** 평가된다. 그런데 `initialNavPath`는
`WebViewHost`에서 `getInitialNotification()`이 resolve된 **뒤에** 채워지는
async state다(`WebViewHost.tsx:252-253`). 네트워크 게이트(`check()`)가 먼저
끝나 root가 마운트되면 ref는 `null`로 굳고, 이후 prop이 바뀌어도 반영하는
effect가 없어 딥링크가 사라진다. 앱이 종료된 상태에서 알림을 탭하는 것이
**가장 흔한 경로**인데 타이밍에 따라 조용히 실패한다.

### G3. 목적지가 전부 root SPA로만 간다 — **UX 격차**
탭 처리(`WebViewInstance.tsx:221-225`)는 무조건 `navigateSpa(path)`, 즉 root
웹뷰의 SPA를 그 경로로 밀어버린다. 하지만 이 앱은 멀티 웹뷰 셸이라
비-메인탭 목적지는 원래 `navigateTo` → **네이티브 sub-page push**로 열려야
한다(`docs/tier3-warm-webview-pool.md`). `/chat/789`, `/councilnoticedetail?id=456`은
메인탭이 아니므로(`constants.ts:28` `MAIN_TAB_PATHS`) 현재는 뒤로가기 스택이
깨진 채 root에 얹힌다.

### G4. 백그라운드에서 notifee 알림 탭이 유실된다
`messaging.ts:144` `notifee.onBackgroundEvent(async () => {})`가 완전 no-op이고,
주석은 "다음 실행 때 `getInitialNotification()`으로 해소된다"고 하지만
notifee의 `getInitialNotification()`은 **앱이 kill된 상태에서 실행된 경우에만**
값을 준다. 포그라운드에서 띄운 배너를 사용자가 앱을 백그라운드로 보낸 뒤
탭하면 `PRESS` 이벤트만 오고 아무도 받지 않는다.

### G5. Android 백그라운드 알림이 잘못된 채널로 간다
`notifee.createChannel({ id: 'default', importance: HIGH })`는 **포그라운드
배너용**이다. 앱이 백그라운드/종료 상태일 때는 OS(FCM SDK)가 직접 알림을
그리는데, 이때 쓰는 채널은 AndroidManifest의
`com.google.firebase.messaging.default_notification_channel_id` 메타데이터로
정해진다. 현재 이 메타데이터가 없어(`app.json`에 설정 없음) Firebase가
자동 생성한 "기타/Miscellaneous" 채널로 떨어진다 — 중요도·소리 설정이 다르고
사용자 설정 화면에도 이상하게 보인다.

### G6. 공유된 가이드의 오류 2건
- `messaging().getInitialMessage()`는 **RNFirebase에 없는 API**다(Flutter쪽
  이름). React Native에서는 `getInitialNotification()`이다.
- 가이드의 `onMessage` 예제가 **수신 즉시 `navigateTo(data.path)`** 를 호출한다.
  사용자가 탭한 적 없는데 보던 화면을 빼앗는 동작이라 잘못됐다. 포그라운드는
  배너만 띄우고 **탭했을 때** 이동해야 한다(현재 코드가 맞게 돼 있다).

현재 코드는 둘 다 올바르므로 코드 수정 없음. 가이드만 정정해 재배포한다.

### G7. 같은 목적지 재탭이 무시된다 — **잠복 버그**
`rootTargetPath`는 문자열 state(`WebViewHost.tsx:215`)이고, 이를 받는
`WebViewInstance`의 effect(`:207-211`)는 `[targetPath]`에만 의존한다. 같은
경로를 두 번 연속 지정하면 state가 바뀌지 않아 effect가 재실행되지 않는다.
같은 알림을 두 번 탭하거나, 사용자가 그 화면에서 다른 데로 이동한 뒤 같은
알림을 다시 탭하면 아무 일도 일어나지 않는다. 기존 `goHome`(`:373`)에도
이미 있는 잠복 결함이며, 딥링크가 이 경로를 재사용하면 표면화된다.

---

## 케이스별 해결 계획

### G1 — 외부 URL 공지 라우팅 [구현 완료]

**변경 대상**: `src/push/navIntent.ts`(신규), `src/webview/constants.ts`,
`src/webview/WebViewHost.tsx`, `src/components/WebViewInstance.tsx`

1. `constants.ts`에 외부 허용 호스트 allowlist를 추가했다. FCM 페이로드는
   신뢰 경계 밖이므로 "포털이 아니면 뭐든 연다"로 가면 안 된다.
   ```ts
   export const PUSH_EXTERNAL_HOSTS = ['inu.ac.kr'] as const;
   ```
   호스트 비교는 **정확히 일치 또는 그 서브도메인**(`host === d ||
   host.endsWith('.' + d)`)이라 `inu.ac.kr` 하나만 넣어도 `cse.inu.ac.kr` 등
   산하 도메인이 전부 허용된다. `.` 경계로 비교하므로 `notinu.ac.kr`이나
   `inu.ac.kr.evil.com` 같은 룩얼라이크는 걸러진다.
2. `resolveNavIntent`(`src/push/navIntent.ts`)가 포털 밖 http(s) URL을 만나면
   allowlist를 확인해 `{ kind: 'external', url }`을, 밖이면 `null`을 반환한다.
3. `WebViewHost.tsx`(콜드스타트)와 `WebViewInstance.tsx`(실시간 탭) 양쪽에서
   `kind === 'external'`이면 `WebBrowser.openBrowserAsync(url)`로 연다.
   `expo-web-browser`는 이미 의존성에 있다(`package.json`).

**`Linking.openURL`이 아니라 인앱 브라우저인 이유**: 웹뷰 안에서의 off-portal
링크 클릭(`WebViewInstance.tsx:376`)은 사용자가 "앱을 떠나겠다"고 명시적으로
누른 것이라 시스템 브라우저가 맞다. 알림 탭은 앱 안에 머무를 것을 기대하는
맥락이라 다르게 간다. 공유된 가이드의 체크리스트는 `Linking.openURL`을
제안하지만, 이 앱의 셸 구조에서는 인앱 브라우저가 맞다.

**대안(더 나음, 웹팀 확인 필요)**: 포털 안에 공지 뷰어 라우트가 있다면
`data.noticeId`로 in-app 경로를 만들어 `push` 인텐트로 돌린다. 그러면 이
케이스는 `external` 없이 G3에 흡수된다. 확인 전까지는 위 allowlist 경로로 간다.

### G2 — 콜드스타트 딥링크 유실

두 가지 층위가 있다. **최종안은 G3와 함께 가는 구조 변경**이지만, 먼저
릴리스해야 한다면 최소 패치만 떼어낼 수 있다.

**(a) 최소 패치** — `WebViewInstance.tsx`에 `targetPath`가 이미 쓰는 패턴
(`:207-211`)을 `initialNavPath`에도 똑같이 적용한다. `useRef` 초기값 대신
effect로 동기화하고, 이미 로드가 끝났으면 즉시 실행한다:

```ts
useEffect(() => {
  if (!isRoot || !initialNavPath) return;
  if (hasLoadedRef.current) navigateSpa(initialNavPath);
  else pendingNavRef.current = initialNavPath;
}, [isRoot, initialNavPath, navigateSpa]);
```
"이미 로드됐으면 즉시" 부분이 핵심이다. effect만 추가하고 큐에만 넣으면
`onLoadEnd`가 이미 지나간 경우(느린 `getInitialNotification` resolve) 여전히
유실된다.

**(b) 최종안** — 딥링크 큐를 host로 올린다(G3 참조). `initialNavPath` prop과
`pendingNavRef`(`:147`, `:401-404`)를 통째로 제거하고, host가 인텐트를 들고
있다가 root의 `onRouteChange` 첫 신호에 flush한다. ref 초기값에 의존하는
구조 자체가 사라지므로 레이스가 재발할 수 없다.

`onLoadEnd`가 아니라 **첫 `routeChange`** 를 준비 신호로 쓰는 이유는 이미
warm pool이 같은 판단을 내린 것과 동일하다(`WebViewInstance.tsx:290-298` 주석:
웹앱 자체의 부트 리다이렉트 `/` → `/home`이 너무 이른 `navigate()`를 덮어쓴다).
딥링크도 정확히 같은 레이스에 노출돼 있다.

### G3 — 목적지 종류별 분기 (SPA / sub-page / 외부)

**변경 대상**: `src/push/navIntent.ts`(신규), `src/push/routeMap.ts`(신규),
`src/push/messaging.ts`, `src/webview/WebViewHost.tsx`,
`src/components/WebViewInstance.tsx`

**1) 인텐트 타입** — `navPath.ts`의 "문자열 하나"로는 목적지 3종을 표현할 수
없으므로 판별 유니온으로 바꾼다:

```ts
export type NavIntent =
  | { kind: 'spa'; path: string }                 // 메인탭 → root SPA
  | { kind: 'push'; path: string; url: string }   // 비-메인탭 → 네이티브 sub-page
  | { kind: 'external'; url: string };            // 포털 밖

export function resolveNavIntent(data?: Record<string, unknown>): NavIntent | null;
```

판정 순서:
1. `routeMap`에 `type`별 매핑이 있으면 그것을 우선.
2. 없으면 `data.path` (구버전 호환으로 `route`/`link`/`url`도 계속 수용).
3. `/`로 시작 → 포털 경로. `isMainTabPath()`(`constants.ts:50`)로
   `spa` / `push` 분기.
4. 절대 URL + host === `PORTAL_HOST` → `pathname + search`로 만들어 3번과 동일.
5. 그 외 http(s) → G1의 allowlist 검사 → `external` 또는 `null`.
6. 그 외 → `null`.

**`push`의 `url` 생성**: `pushSub`은 `isPortalUrl(url)` 가드
(`WebViewHost.tsx:327`)를 통과해야 하므로 반드시 포털 오리진으로 만들어야
한다. `constants.ts`에 헬퍼를 둔다: `portalUrlFor(path) => new URL(path,
ROOT_URL).toString()`. 웹이 `navigateTo`에서 쓰는 계산과 동일하다.

**쿼리스트링 보존 주의**: `normalizePath()`는 `?`·`#`를 잘라내므로
(`constants.ts:42`) **메인탭 판정에만** 쓰고, 실제로 넘기는 path는 원본이어야
한다. `/councilnoticedetail?id=456`에서 `id`가 날아가면 알림이 무의미해진다.

**2) `routeMap.ts`** — `type` → 포털 경로 생성표. 웹팀 확정 전까지 비워 두고
`data.path` fallthrough로 동작시킨다. 확정되면 이 파일만 채우면 된다
(`FRIEND` 상세 경로, 공지 in-app 뷰어 등).

**3) 구독을 host로 이관** — `push` 인텐트는 네이티브 스택 소유자만 실행할 수
있다. `WebViewInstance.tsx:220-225`의 구독을 제거하고 `WebViewHost`에서
구독해 분기한다:

| 인텐트 | 실행 | 재사용하는 기존 코드 |
|---|---|---|
| `spa` | `goHome(path)` | `WebViewHost.tsx:373` (popToRoot + rootTargetPath) |
| `push` | `pushSub(url, path)` | `:324` — warm slot adopt까지 그대로 탐 |
| `external` | `WebBrowser.openBrowserAsync(url)` | 신규 |

셋 다 이미 있는 프리미티브라 새 네비게이션 코드는 사실상 없다.

**스택 정책**: `push`는 열려 있는 sub-page 위에 **얹는다**(collapse 안 함).
백그라운드에서 알림을 탭한 사용자가 뒤로가기로 원래 보던 화면에 돌아올 수
있어야 한다. `spa`는 메인탭이 목적지이므로 `goHome` 의미대로 collapse한다.

**포그라운드 배너**(`setupForegroundNotifications`)도 같이 host로 올려 알림
생명주기를 한 곳에 모은다. root 인스턴스는 알림을 전혀 모르게 된다.

### G4 — 백그라운드 notifee 탭 유실

**변경 대상**: `src/push/messaging.ts`

React 트리 밖(백그라운드 핸들러)에서 쓸 수 있어야 하므로 **모듈 스코프 큐**를
둔다. 구독자가 있으면 즉시 전달하고, 없으면 쌓아 둔다:

```ts
let pending: NavIntent | null = null;
let subscriber: ((i: NavIntent) => void) | null = null;

function deliver(intent: NavIntent | null) {
  if (!intent) return;
  if (subscriber) subscriber(intent);
  else pending = intent;   // 아직 host가 구독 전 → 큐잉
}
```

- `notifee.onBackgroundEvent`에서 `EventType.PRESS`면 `deliver()`.
  (현재 `messaging.ts:144`의 완전 no-op을 대체)
- `subscribeNotificationOpen`은 구독 즉시 `pending`을 비우며 콜백한다.
  백그라운드 탭 → 앱 복귀 시 host가 이미 살아 있으면 즉시, 아니면 마운트 시점에
  전달된다.
- `getInitialNavIntent()`는 ① `pending` ② `messaging().getInitialNotification()`
  ③ `notifee.getInitialNotification()` 순으로 확인하고 소비 시 비운다.

**중복 처리 방지**: FCM `messageId` / notifee `notification.id`를 최근 N개(8개면
충분) 링버퍼로 기억해 같은 알림이 두 경로로 두 번 처리되지 않게 한다. kill
상태에서 탭한 경우 `pending`과 `getInitialNotification()`이 동시에 값을 가질 수
있다.

### G5 — Android 기본 알림 채널

**변경 대상**: `plugins/withDefaultNotificationChannel.js`(신규), `app.json`

`@react-native-firebase/messaging`의 config plugin은 이 옵션을 노출하지 않으므로
로컬 plugin을 만든다:

```js
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

module.exports = (config) =>
  withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      app,
      'com.google.firebase.messaging.default_notification_channel_id',
      'default',
    );
    return cfg;
  });
```

`app.json`의 `plugins` 배열에 `"./plugins/withDefaultNotificationChannel"`를
추가한다.

**채널 id는 notifee가 만드는 `'default'`(`messaging.ts:23`)와 반드시 일치**시킨다.
그래야 포그라운드 배너와 백그라운드 알림이 같은 채널·같은 중요도로 뜬다.

**주의**: 매니페스트 변경이라 **`expo prebuild` + 네이티브 재빌드**가 필요하다.
OTA로 안 나간다. 같은 plugin에서 `default_notification_icon` /
`default_notification_color`도 지정할지는 디자인 확인 후 결정한다(현재는 앱
아이콘이 흰 사각형으로 나오는 흔한 문제 대상).

### G6 — 가이드 정정

코드 변경 없음. 웹/서버팀에 회람된 가이드를 두 군데 고쳐 재배포한다:

1. `getInitialMessage()` → **`getInitialNotification()`**.
2. `onMessage` 예제에서 **수신 즉시 라우팅하는 코드를 제거**하고, 로컬 알림을
   표시한 뒤 탭 이벤트에서 라우팅하도록 바꾼다. 현재 예제대로 하면 사용자가
   앱을 쓰는 도중 화면이 강탈된다.

덧붙여, 이 앱에서는 `notification` 블록이 항상 동봉되므로 백그라운드 표시는
OS가 담당하고 `setBackgroundMessageHandler`는 핸들러 존재 목적으로만 비어
있다는 점을 명시해 두면 서버팀의 data-only 발송 유혹을 막을 수 있다.

### G7 — 같은 목적지 재탭

**변경 대상**: `src/webview/WebViewHost.tsx`, `src/components/WebViewInstance.tsx`

`rootTargetPath`를 문자열에서 **매번 새 객체**로 바꿔 effect가 항상 재실행되게
한다:

```ts
// WebViewHost
const [rootTarget, setRootTarget] = useState<{ path: string; seq: number }>();
const goHome = useCallback((path: string) => {
  popToRoot();
  setRootTarget({ path, seq: ++navSeqRef.current });
}, [popToRoot]);
```

`WebViewInstance`의 `targetPath` prop을 이 객체로 받아 effect 의존성을
`[target]`으로 두면, 같은 경로여도 `seq`가 달라 새 객체 → 재실행된다.

**warm pool 쪽 주의**: 같은 `targetPath` prop을 warm slot도 쓴다
(`WebViewHost.tsx:447`). warm은 "최신 인텐트가 이전 것을 덮어쓴다"는 의미로
값 동등성에 의존하므로(`:296` `handlePrewarm`), 두 경로가 같은 prop 타입을
공유하도록 바꿀 때 warm 쪽 동작이 변하지 않는지 확인한다. 가장 안전한 건
`targetPath`(warm용, 문자열 유지)와 `driveTarget`(딥링크·goHome용, 객체) 을
**별도 prop으로 분리**하는 것이다.

---

## 테스트

`src/push/__tests__/navIntent.test.ts`(신규). 순수 함수라 네이티브 모듈 없이
현재 jest 설정 그대로 돈다:

- 4개 타입 × 서버 예시 페이로드 → 기대 `NavIntent` 매핑.
- 메인탭(`/home`, `/m/home`, `/chat/list`) → `spa`,
  비-메인탭(`/chat/789`, `/councilnoticedetail?id=456`) → `push`.
- `/councilnoticedetail?id=456`의 **쿼리스트링 보존**(G3의 함정).
- 포털 절대 URL → 상대경로 변환.
- allowlist 안 호스트(`inu.ac.kr`, 서브도메인 `cse.inu.ac.kr` 포함) → `external`,
  밖(`evil.example.com`) → `null`.
- `data` 값이 전부 문자열로 와도 동작 / 빈 값·누락 필드 → `null`.

`navPath.test.ts`의 기존 케이스는 회귀 가드로 유지한다.

`messaging.ts`의 큐(G4)는 네이티브 모듈 의존이라 현 jest 설정으로는 못 돈다.
큐 로직만 `src/push/pendingIntent.ts`로 분리하면 순수 테스트가 가능하다 —
중복 억제와 "구독 전/후" 전달 분기가 실수하기 쉬운 부분이라 분리할 값어치가 있다.

## 수동 검증

4개 타입 × 3가지 앱 상태(포그라운드 / 백그라운드 / 종료) = 12 케이스를
Android·iOS 양쪽에서. 발송은 FCM 콘솔이 아니라 **HTTP v1 API**로 한다 —
콘솔은 임의 `data` 키를 실을 수 없다.

- 종료 상태 탭 → 스플래시 → **목적지로 바로** (홈 깜빡임 후 이동이 아님). ← G2
- 백그라운드 탭 → 열려 있던 스택 **위에** push되고 뒤로가기로 원래 화면 복귀. ← G3/G4
- 포그라운드 수신 → 배너 1개만(중복 없음), **탭해야** 이동. ← G6
- 같은 알림 연속 2회 탭 → 두 번째도 동작. ← G7
- 공지 → 인앱 브라우저로 원문, 닫으면 앱 복귀. ← G1
- Android 알림 설정에 "알림" 채널 1개만, "기타" 채널 없음. ← G5

## 작업 순서 (PR 분리 제안)

1. **PR-A (핫픽스)**: G2(a) 최소 패치. 3줄. 단독 릴리스 가능.
2. **PR-B**: G1 + G3 + G2(b) — `navIntent` 도입과 host 이관은 한 덩어리다.
3. **PR-C**: G4 + G7 — 탭 전달 신뢰성.
4. **PR-D**: G5 — 네이티브 재빌드가 필요하므로 분리.
5. G6은 코드 변경이 아니므로 문서 회람으로 즉시.

## 범위 밖 / 후속

- **RNFirebase modular API 이관**: v22+에서 `messaging()` 네임스페이스 API가
  deprecated로 경고를 낸다. `getMessaging()`/`onMessage()` 모듈러 형태로
  옮기는 건 별도 작업으로 분리한다(이번 변경과 섞으면 리뷰가 어려워짐).
  *현재 `node_modules` 미설치 상태라 설치된 버전의 실제 deprecation 여부는
  확인하지 못했다 — 착수 전 확인 필요.*
- 알림 뱃지 카운트 동기화(서버 미제공).
- `type`별 알림 그룹핑/요약(Android channel group, iOS thread-id).

## 웹팀 확인 필요

1. 포털 안에 학교/학과 공지 뷰어 라우트가 있는가? 있으면 `noticeId`로
   in-app 라우팅 가능 → `external` 대신 `push`.
2. `/councilnoticedetail?id=456` 등 알림 목적지 경로가 **`navigateTo`로
   push되는 비-메인탭**이 맞는지 (메인탭이면 `spa`로 분류해야 함).
3. `FRIEND` 상세 페이지 경로 확정 시점.

## 서버팀 확인/공지 필요

서버 이슈 #271의 "3. 환경별 PORTAL_HOST 정합성 확인" 항목은 풀 URL
`data.path`의 host가 **클라이언트 `PORTAL_HOST`와 정확히 일치**해야 한다고
전제한다. 그런데 이 앱은 `SCHOOL_NOTICE`/`DEPARTMENT`(학교/학과 공지)를
`PORTAL_HOST`가 아닌 **별도 외부 도메인**(`inu.ac.kr` 및 서브도메인,
학교에서 제공하는 신뢰 가능한 도메인이라 G1에서 allowlist로 별도 처리 —
위 "진행 상태" 참조)으로 받는다고 가정하고 구현했다. 서버가 #271의 규칙대로
"host 불일치 시 전부 무시"로 통일해 버리면 공지 타입 알림의 `path`가 클라이언트
쪽 `PORTAL_HOST` 검사에서 걸러져 **드롭**된다.

서버팀에 명시적으로 확인이 필요하다:
- `SCHOOL_NOTICE`/`DEPARTMENT`는 `PORTAL_HOST` 일치 규칙의 **예외**로 두고
  외부 도메인 그대로 보낸다 — 이 문서의 G1 가정이 맞다는 전제로 진행 중.
- 위 전제가 틀렸다면(예: 공지도 포털 내 뷰어로 감싸 `PORTAL_HOST` 아래 경로로
  보낼 계획이라면) G1의 allowlist/외부 브라우저 분기 자체가 불필요해지고,
  대신 "웹팀 확인 필요" 1번(포털 내 공지 뷰어 라우트)으로 합류해야 한다.
- dev/staging/prod 각 환경의 `PORTAL_HOST` 값이 클라이언트 빌드 설정과
  실제로 일치하는지(현재 `constants.ts`의 `PORTAL_HOST`는 로컬 개발 서버
  `localhost:5173`으로 임시 고정돼 있음 — 프로덕션 값으로 교체 필요, 이 항목은
  이 이슈와 별개로도 처리해야 함).
