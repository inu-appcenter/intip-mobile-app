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
- Phase 0 계측을 켠 채 **warm-hit vs 콜드**의 push 지연 비교 캡처(목표: warm-hit에서 JS 부트 구간 소거).
- 시나리오: ① 링크 touchstart→tap warm-hit, ② 워밍 안 된 다른 링크 콜드 폴백, ③ 스와이프백 pop, ④ parked 중 CPU/네트워크 정지(웹소켓 끊김 확인), ⑤ 메모리 압박/`simctl`로 WebContent 종료 시 콜드 폴백, ⑥ TTL 경과 후 재워밍.

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
