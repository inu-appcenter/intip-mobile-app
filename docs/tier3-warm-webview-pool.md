# Tier 3: 웜 웹뷰 풀 + 재사용 (warm-instance reuse)

## Context

`navigateTo`가 비-메인탭으로 이동할 때마다 `webview.tsx`가 **새 expo-router 스크린 + 새 WKWebView**를 mount하고, 그 웹뷰는 URL을 **콜드 로드**한다(번들 다운로드 → JS 파싱·실행 → React 부트 → 데이터 fetch → 페인트). 시뮬레이터 검증에서 push 체감이 느렸고, 가장 비싼 비용은 **인스턴스마다 새로 일어나는 JS 부트**다.

WKWebView는 인스턴스당 JS 컨텍스트가 독립이라, 다른 웹뷰를 미리 데워둬도 **그 인스턴스를 실제로 재사용하지 않으면 JS 부트 비용이 안 줄어든다**. 그리고 react-native-webview의 네이티브 뷰는 부모 트리 간 reparent가 불가(이동 시 remount→상태 소실)다. 따라서 warm 인스턴스는 **스크린 트리 밖 영속 레이어**에 살아야 한다.

목표: 사용자 인텐트(링크 touchstart) 시점에 웹뷰 1개를 셸-부트 + 목표 path로 미리 SPA 라우팅해 두고, 실제 `navigateTo` 때 **그 인스턴스를 그대로 노출**해 JS 부트를 건너뛴다. 대기 중 웹뷰는 suspend로 CPU/배터리/네트워크를 거의 0으로 만든다.

## 확정된 정책 (대화에서 합의)

- **Tier 3 (warm 인스턴스 재사용)** 로 진행. paint 프리워밍은 비목표(숨겨도 됨).
- **네비게이션 소유 = 커스텀 호스트 스택**: sub-page는 expo-router native-stack 대신 Reanimated 슬라이드 + gesture-handler 스와이프백으로 자체 관리. (root는 그대로.)
- **풀 크기 = 1 warm 슬롯**, root가 idle된 뒤 **lazy 워밍**, 미사용 시 **TTL eviction**.
- **suspend 프로토콜**: 숨김 + `setActive(false)` → `document.hidden` 구동 + 웹소켓/폴링/heartbeat/미디어 명시 중단. visibility-aware(React Query refetch 등)는 hidden으로 자동 정지.
- **staleness**: 셸만 워밍, 콘텐츠는 reveal 시 **React Query revalidate**. 글로벌/세션 상태의 웹뷰 간 공유 스토어는 **후속 워크스트림**(이번 범위 제외).
- **jetsam 대비**: warm WebContent 종료 감지 → reveal 직전 생사 확인, 죽었으면 콜드 폴백.

## 아키텍처

reparent 불가 → **WebViewHost(영속 레이어)가 모든 콘텐츠 웹뷰 인스턴스를 소유**하고, 라우터 스크린/스택 엔트리는 "어떤 인스턴스를 어디에 보일지"만 지시하는 placeholder가 된다.

```
WebViewProvider
 ├─ <Stack> (expo-router)
 │   └─ index  → root 웹뷰 placeholder (메인탭 SPA)
 └─ <WebViewHost/>           ← Stack 위 영속 오버레이, 모든 웹뷰 인스턴스 소유
     ├─ root instance        (항상 mount, 메인탭)
     ├─ sub instance(s)      (열린 sub-page마다 1개, 커스텀 스택)
     └─ warm slot (1)        (숨김·suspend, lazy/TTL)
```

- **인스턴스(WebViewInstance)**: `webViewRef` + `createNativeChannel` + 핸들러를 소유하는 "콘텐츠 단위". 호스트 안에서만 mount/unmount되고 스크린 트리로 이동하지 않는다 (현 `WebViewContainer`의 webview·channel 부분을 추출).
- **커스텀 sub-스택**: 호스트가 sub 인스턴스 배열을 Reanimated로 슬라이드 인/아웃, gesture-handler로 스와이프백 pop. native-stack(`webview.tsx`)을 대체.
- **풀 매니저**: warm 슬롯 1개 생성/park/adopt/re-warm/evict 수명주기.

## 구현 단계

### Phase 0 — 베이스라인 측정 (먼저, 싸게)
- 웹: `navigationStart → first-paint → data-ready` 타임스탬프를 기존 `logWebDiagnostics` 채널로 전송, native가 로그.
- **프로덕션 빌드**로 `localhost:5173` 대신 측정(현 dev 서버 confound 제거): `inu-portal-web`에서 `npm run build && npx vite preview --port 5173`.
- 콜드 push 지연을 수치화해 Tier 3 도입의 이득 폭을 확정(여기서 충분하면 범위 축소 가능).

### Phase 1 — 브릿지 스키마 확장 (`@inu-appcenter/intip-bridge`)
`src/messages.ts`에 메시지 2종 추가(구체 union + drift 가드 패턴 그대로):
- **`prewarm`** (Web→Native), value `{ url: string; path: string }` — touchstart 인텐트.
- **`setActive`** (Native→Web), value `boolean` — parked 웹뷰 suspend(false)/resume(true).
- 버전 bump → CI(`v*` 태그) publish → 두 레포 `npm update`.

### Phase 2 — 웹: suspend/resume + prewarm 인텐트 (`inu-portal-web`)
- `src/utils/bridgeChannel.ts`: `channel.on('setActive', active => ...)` 추가.
  - **suspend(false)**: `document.hidden` 강제 + `visibilitychange` dispatch; React Query `queryClient`의 진행 쿼리 cancel·refetch 중단; 웹소켓/SSE disconnect; 커스텀 `setInterval` 폴링·analytics heartbeat 정지; 미디어 pause.
  - **resume(true)**: 위 역연산 + 목표 route의 React Query **invalidate/refetch**(reveal-revalidate).
- **suspendable 레지스트리**: 각 구독(소켓/폴링/쿼리)이 등록하는 작은 모듈(`src/utils/suspendable.ts` 신규) — suspend가 전부 순회 정지. `queryClient`는 `main.tsx`에서 주입.
- **prewarm 인텐트**: 앱 환경일 때 document에 위임 `touchstart` 리스너 — 앵커/내부 네비 트리거의 목표 path를 추출해 `channel.send('prewarm', { url, path })`. 기존 `appBridge.navigateTo` 경로와 동일 URL 산출 로직 재사용.

### Phase 3 — 네이티브: 호스트 레이어 + 커스텀 sub-스택 (`intip-mobile-app`)
- **`WebViewInstance` 추출**: 현 `src/components/WebViewContainer.tsx`에서 webview/channel/핸들러 부분을 `src/components/WebViewInstance.tsx`로 분리(이 대화에서 배선한 `createNativeChannel` 결선 그대로 이전). props로 `visible`/`active`/`onContentProcessTerminated` 수신.
- **`WebViewHost`** 신규(`src/webview/WebViewHost.tsx`): root + sub 배열 + warm 슬롯을 절대배치로 렌더, 활성 1개만 visible. `_layout.tsx`에서 `WebViewProvider` 직하·`<Stack>` 위에 배치.
- **커스텀 스택 네비게이션**: 호스트가 sub 인스턴스 스택을 보유. push = 슬라이드 인(Reanimated), 스와이프백 = gesture-handler `Gesture.Pan`으로 진행도 구동 후 임계 넘으면 pop. `react-native-safe-area-context`로 인셋 처리.
- **`_layout.tsx` 변경**: `webview` `Stack.Screen` 제거(native-stack push 폐기). `index`(root)만 유지. sub 네비게이션은 호스트가 담당.
- **orchestrator 연동**: 기존 `WebViewContext`의 `registry`(stack/handles/navigator) 재사용 — `registerNavigator`를 **호스트의 push/pop/popToRoot**로 채움. 인스턴스는 기존대로 `registerWebView`/`updateWebView`로 등록(컨트롤러/dev-menu 호환 유지).

### Phase 4 — 풀 매니저: warm 1 슬롯 (`intip-mobile-app`)
호스트 내부 `useWarmPool` 훅/매니저:
- **lazy 생성**: root가 첫 `routeChange`(셸 부트 신호)로 interactive된 뒤, idle 타이밍에 warm 슬롯 1개를 중립/parked 라우트로 부트 → 즉시 `channel.send('setActive', false)`.
- **prewarm 처리**: root 채널의 `channel.on('prewarm', ({url,path}) => ...)` — warm 슬롯을 그 path로 SPA 프리내비(`channel.send('navigate', path)` 또는 url 로드). 인텐트 변경 시 최신 url로 override.
- **adopt-on-navigateTo**: 기존 `navigateTo` 핸들러를 변경 — host.pushSub(url, path) 시 **warm 슬롯 url이 일치하면 그 인스턴스를 새 sub 슬롯으로 승격** + `setActive(true)` + reveal-revalidate; 불일치/없음/죽음이면 **콜드 인스턴스 생성**(현 동작). 승격 후 **다음 +1용 warm 슬롯 재생성**.
- **TTL eviction**: warm 미사용 N초 후 슬롯 unmount(메모리 회수), 다음 인텐트에 재워밍.
- **jetsam 복구**: 인스턴스 `onContentProcessDidTerminate`(iOS)/`onRenderProcessGone`(Android) → 해당 슬롯 dead 표시; warm이면 폐기, 활성이면 reload.

### Phase 5 — 검증 (iOS 시뮬레이터)

M1/M2는 구현·기본 시나리오까지 시뮬레이터에서 검증됨(`WebViewHost.tsx`/`WebViewInstance.tsx`). 이 섹션은 **① 정량 속도 측정**과 **② 에지케이스/이상 사용 패턴** 두 축으로 확장한 상세 계획이다.

구현 중 실제로 두 개의 상태-타이밍 버그를 잡은 전례가 있다(경고로 남겨둠):
- **리컨실리에이션 버그**: warm 슬롯을 `{subs.map(...)}`와 다른 형제 JSX로 렌더링하면 promote 시 React key가 같아도 리마운트됨(같은 배열 안에서만 key가 identity를 보존) → JS 재부팅 비용이 그대로 남아 기능 자체가 무력화됨. `renderLayers` 단일 배열로 병합해 해결.
- **내비게이션 레이스**: warm 인스턴스의 prewarm 타겟 이동을 `onLoadEnd`(document load)에서 flush하면 웹앱 자체의 부팅-시 리다이렉트(`/` → `/home`)와 경합해 조용히 덮어써짐 → 첫 `routeChange` 수신 시점으로 flush를 옮겨 해결.

두 버그 모두 "겉보기엔 맞는 코드가 타이밍/reconciliation 때문에 조용히 실패"하는 패턴이었다. 아래 에지케이스 목록은 같은 패턴이 남아있는지 훑기 위한 것 — 특히 **C. Pool 상태 레이스**가 우선순위 1순위.

#### ① 속도 측정 방법론

- Phase 0 계측(`logWebDiagnostics`: `navigationStart → first-paint → data-ready`)을 켠 채, **production 빌드**(`vite preview`, `localhost:5173` dev 서버 confound 제거)로 측정.
- 비교 축: **콜드 push**(warm 미스) vs **warm-hit push**(adopt 성공) — 목표는 warm-hit에서 "JS 부트+React 마운트" 구간이 사라지고 "SPA 라우팅+데이터 fetch"만 남는 것.
- 측정 매트릭스:

| 시나리오 | 기대 결과 |
|---|---|
| 콜드 push (warm 없음/불일치) | 기존과 동일한 전체 부트 지연 |
| warm-hit push (정확히 매치) | 부트 구간 소거, reveal-revalidate만큼만 지연 |
| lazy-warm 완료 직후 곧바로 push (prewarm 인텐트 없이 우연히 neutral path 일치) | 해당 없음(neutral path는 실사용 경로가 아님 — 실측 무의미, 스킵) |
| TTL 만료 직후 push | 콜드와 동일해야 함(재워밍 전) |
| 2연속 push(첫 push가 재워밍한 슬롯을 두 번째가 즉시 adopt) | 두 번째도 warm-hit 지연이어야 함 — `spawnWarm()` 재워밍이 충분히 빨리 도는지 확인 |

- 계측 로그는 `console.log('[web-diagnostics]', diag)`(`WebViewInstance.tsx`)에 있으므로, Metro 로그를 grep해 타임스탬프 차이를 계산. 필요시 이번 세션에서 썼던 것과 같은 TEMP 계측을 다시 붙였다 제거하는 방식으로 진행(프로덕션 코드에 상시 로깅은 남기지 않음).

#### ② 정상 경로 시나리오 (회귀 확인용, 이미 1회 검증됨 — 재확인만)

1. 링크 touchstart → tap → warm-hit reveal.
2. 워밍 안 된(경로 불일치) 링크 → 콜드 폴백.
3. 스와이프백 pop(promote된 인스턴스도 동일하게 동작하는지 — promote 후 인스턴스가 진짜로 같은지 `WebViewInstance`의 `id`가 승격 전후 동일한지로 판별 가능, 이번 세션에서 쓴 방법 재사용).
4. parked 중 CPU/네트워크 정지 확인(`setActive(false)` → `document.hidden` 강제 → 웹소켓/폴링 실제로 끊기는지 `inu-portal-web` 쪽 Safari 원격 디버깅 또는 네트워크 패널로 확인 — 이번 세션엔 Safari Web Inspector가 샌드박스 제약으로 연결 못 했음, 재시도 필요).
5. 메모리 압박(`xcrun simctl spawn <udid> notifyutil -p com.apple.system.memorypressure` 또는 Xcode Instruments의 Memory 시뮬레이션)로 warm 슬롯의 WebContent 종료 → `markWarmDead` → 이어지는 push가 콜드 폴백하는지.
6. TTL(`WARM_TTL_MS`, 현재 60s) 경과 후 재워밍 — 경과 전/후 push 결과가 각각 warm-hit/콜드인지.

#### ③ 에지케이스 / 이상 사용 패턴 (신규 — 아직 검증 안 됨)

**A. 빠른 반복 탭**
- A1. 같은 링크 더블탭(거의 동시 두 번의 `navigateTo`). 기대: sub가 중복 생성되지 않고, `subs` 배열에 같은 `key`가 두 번 들어가지 않는지(React key 중복 경고 유무 확인). `pushSub`가 `warmRef.current`(ref, `useEffect`로 커밋 후 미러링됨)를 읽으므로, 두 이벤트가 같은 React 커밋 사이 틈에 들어오면 두 번째 호출도 "아직 안 지워진" 같은 warm을 보고 **동시에 두 번 adopt**를 시도할 이론적 위험이 있음 — WebView bridge 메시지가 실제로 같은 tick에 두 번 들어올 수 있는지부터 확인.
- A2. 서로 다른 두 링크를 빠르게 연속 탭(A→B, B가 A의 push 애니메이션이 끝나기 전 도착). 기대: 스택에 A, B 순서대로 정상 push, B가 A를 대체하거나 스택이 꼬이지 않음.
- A3. 뒤로가기 버튼(웹 chevron 또는 스와이프) 연타 — `pop()`이 `subsRef.current[length-1]`을 두 번 이상 잡아 같은 레이어에 `close()`가 중복 호출되는지, `onRemoved`가 중복 fire해 `removeSub`가 이미 없는 key를 filter해도 안전한지(현재 코드는 안전할 것으로 보이나 실기기 확인 필요).

**B. 네비게이션 중 인터럽트**
- B1. 스와이프백 애니메이션(220ms) 진행 중 같은 링크 재탭 — 팝 애니메이션이 끝나기 전에 새 push가 들어옴. 레이어가 겹치거나 잘못된 레이어가 top으로 판정되는지(`isTop = lastSubIndex` 계산이 `subs` state 기준이라 애니메이션 중에도 정확해야 함 — `SubLayer`의 `close()`는 시각적 애니메이션일 뿐 `subs`에서는 `onRemoved`가 불릴 때까지 안 빠짐. 그 사이 새 push가 오면 `subs.length`가 잠깐 2인 상태로 top 판정이 맞는지).
- B2. 스와이프백 제스처를 임계값(33%) 근처에서 여러 번 왔다갔다(끝까지 안 밀고 손 떼기 반복) — `Gesture.Pan`의 `onUpdate`/`onEnd` 재진입, `tx` shared value가 스프링/타이밍 애니메이션 중첩으로 이상한 위치에 멈추지 않는지.
- B3. `restoreSession`(dev 컨트롤러) 실행 중(`popToRoot` → 180ms 간격 `push` 반복) 동시에 warm 풀이 살아있는 상태 — `popToRoot`가 `subs`만 비우고 `warm`은 안 건드리므로, restore 시퀀스의 첫 push가 우연히 살아있는 warm과 경로가 일치하면 의도치 않게 adopt될 수 있음(기능적으로는 문제 없어야 하나, 세션 복원 순서/타이밍이 꼬이는지 확인).

**C. Pool 상태 레이스 (우선순위 1순위)**
- C1. TTL 타이머 만료와 adopt 탭이 근접한 타이밍(예: TTL 59.9초 시점에 탭) — `setWarm(null)`과 `pushSub`의 `warmRef.current` 읽기 순서에 따라 정상적으로 콜드 폴백하는지, 혹은 "죽은 순간의" warm을 여전히 adopt 시도해 빈 화면/에러가 뜨는지.
- C2. Jetsam(WebContent 종료)이 발생한 직후 곧바로 같은 경로로 탭 — `markWarmDead`(alive:false)가 `pushSub`의 `w?.alive` 체크에 확실히 반영되는 타이밍인지.
- C3. 두 번째 prewarm 인텐트(다른 경로)가 첫 번째 prewarm의 `navigateSpa` flush(첫 `routeChange` 대기 중)가 아직 안 끝난 상태에서 도착 — "최신 인텐트가 우선"이 실제로 지켜지는지, 즉 최종적으로 웹뷰가 **두 번째** 경로에 정착하는지(`pendingTargetRef` 덮어쓰기 로직 검증).
- C4. 승격(promote) 직후 곧바로 재워밍된 새 warm 슬롯(`spawnWarm()`)에 대해 새로운 prewarm 인텐트가 도착 — 재워밍 슬롯도 동일하게 정상 동작하는지(1회성이 아니라 반복 가능한지).

**D. 라이프사이클 인터럽트**
- D1. warm 슬롯이 parked인 상태로 앱을 백그라운드로 보냈다가 복귀 — iOS가 백그라운드에서 JS 타이머(TTL, lazy-warm delay)를 지연/일시정지시킬 수 있음. 복귀 직후 TTL이 몰아서 발동하거나 중복 스폰되지 않는지.
- D2. lazy-warm 타이머(1.5s) 대기 중 앱을 백그라운드로 보냈다가 복귀 — 웜 슬롯이 정상적으로 한 번만 스폰되는지.
- D3. 저사양 기기/시뮬레이터에서 메모리 경고 발생 시 OS가 **루트**가 아닌 **활성 sub**를 종료하는 케이스(현재 코드는 `active !== false`면 자기 reload로 self-heal — 실제로 자연스럽게 리로드되는지, 사용자에게 빈 화면이 잠깐이라도 노출되는지).

**E. 콘텐츠 무결성**
- E1. warm 슬롯의 SPA 프리내비게이션 대상(`targetPath`) 로드가 네트워크 오류로 실패 — `alive`는 여전히 true(jetsam이 아니므로)라서 `pushSub`가 이 슬롯을 adopt할 수 있음. 이 경우 사용자에게 깨진/빈 페이지가 그대로 보여질 위험 — 현재 코드에 로드 실패 감지·폴백 로직 없음(범위 밖일 수 있으나 최소 리스크로 문서화 필요).
- E2. `prewarm`으로 받은 경로가 로그인 필요 페이지인데, warm 슬롯이 아직 비로그인 상태로 프리내비된 경우 — adopt 후 로그인 리다이렉트가 자연스럽게 뜨는지, 혹은 어색한 화면 전환이 있는지.

#### 실행 메모
- 대부분의 C·A 시나리오는 실기기 탭 타이밍을 정밀 제어하기 어려우므로, 이번 세션에서 쓴 방식대로 **임시 `console.log` 계측 + `idb ui tap`/`idb ui swipe`를 스크립트로 빠르게 연타**해 재현 시도 → 통과/실패 확인 후 계측 제거.
- C1·C2처럼 순수 타이밍 레이스는 시뮬레이터에서 안정적으로 재현되지 않을 수 있음 — 이 경우 **코드 리뷰로 논리적 안전성을 재확인**(예: `pushSub`의 `warmRef.current` 체크를 함수형 `setState` 콜백 내부로 옮겨 항상 최신 상태를 보게 하는 방어적 리팩터 고려)하는 것으로 갈음 가능.
- 실패가 재현되면 원인은 거의 항상 "state/ref 커밋 타이밍" 또는 "React reconciliation 슬롯 불일치"일 가능성이 높음 — 이번 세션에서 잡은 두 버그와 같은 계열.

## 핵심 파일

| 레포 | 파일 | 작업 |
|---|---|---|
| intip-bridge | `src/messages.ts` | `prewarm`/`setActive` 추가 + republish |
| inu-portal-web | `src/utils/bridgeChannel.ts` | `setActive` 핸들러(suspend/resume) |
| inu-portal-web | `src/utils/suspendable.ts` (신규) | suspendable 구독 레지스트리 |
| inu-portal-web | `src/utils/bridgeChannel.ts` / 네비 유틸 | touchstart→`prewarm` 인텐트 |
| inu-portal-web | `src/main.tsx` | queryClient 주입 |
| intip-mobile-app | `src/components/WebViewInstance.tsx` (신규) | WebViewContainer에서 webview/channel 추출 |
| intip-mobile-app | `src/webview/WebViewHost.tsx` (신규) | 영속 레이어 + 커스텀 sub-스택 + warm 풀 |
| intip-mobile-app | `src/app/_layout.tsx` | `webview` 스크린 제거, 호스트 배치 |
| intip-mobile-app | `src/app/webview.tsx` | 폐기(또는 placeholder로 축소) |
| intip-mobile-app | `src/webview/WebViewContext.tsx` | `registerNavigator`를 호스트 push/pop에 연결(재사용) |

## 재사용 포인트
- 브릿지: 이미 배선된 `createNativeChannel`(native) / `createWebChannel`(web)·`bridgeChannel` 싱글톤·`channel.send('navigate')`(reveal SPA 이동)·`routeChange`(셸 부트 신호).
- orchestrator: `WebViewContext`의 `registry`/`StackNavigator`/`WebViewHandle` 그대로 — 호스트가 navigator 구현만 교체.
- 의존성: reanimated 4.3.1·gesture-handler 2.31·safe-area-context 5.7 전부 보유(신규 설치 없음).

## 리스크 / 주의
- **메모리 floor**: warm 1개 = WebContent 프로세스 1개분(수십 MB) — 불가피. 풀 1 + TTL로 한정.
- **suspend 누수**: 새 웹 기능이 visibility 무시 폴링/소켓을 추가하면 parked 비용 부활 → suspendable 레지스트리에 등록 강제(코드 리뷰 규약).
- **애니메이션 충실도**: 커스텀 스택이 native-stack의 무료 제스처를 대체 — 스와이프백 진행도·인셋·엣지 처리 직접 구현 필요(가장 큰 신규 작업).
- **컨트롤러/세션 복원**: `restoreSession`(WebViewContext)이 navigator.push에 의존 → 호스트 navigator로 동등 동작 보장 필요.
- **dev 서버 confound**: Phase 0를 프로덕션 빌드로 측정하지 않으면 이득 오판 가능.
