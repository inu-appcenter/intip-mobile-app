# 뒤로가기 정책 (앱 전반)

`intip-mobile-app#15` 로 정리된, 셸(네이티브)과 웹(inu-portal-web) 사이의 뒤로가기
역할 분담. 세 저장소(mobile / web / intip-bridge)가 함께 지킨다.

## 원칙

**셸은 뒤로가기를 스스로 판단하지 않는다.** 웹뷰 안에 열린 모달이 있는지, 되돌릴
SPA 히스토리가 있는지 아는 쪽은 웹뿐이다. 셸이 이걸 건너뛰던 게 이슈 #15 였다 —
채팅방(서브페이지)에서 이미지 뷰어를 열어둔 채 뒤로가기를 하면 이미지가 아니라
채팅방 화면이 통째로 닫혔다.

## 세 가지 경로

| # | 이벤트 주체 | 흐름 |
| --- | --- | --- |
| 1 | 웹 헤더/내부 백버튼 | 웹이 판단: 되돌릴 것이 있으면 웹에서 처리, 없으면 브릿지 `goBack` 으로 네이티브 pop 요청 |
| 2 | Android 시스템 백 (버튼 + 엣지 스와이프) | 네이티브가 `checkBack` 을 웹으로 보내고, 웹의 `backResult` 로 결정 |
| 3 | iOS 스와이프 백 | **비활성화**. iOS 에는 하드웨어 백이 없고, 뒤로가기는 1번(웹 헤더 백버튼)뿐 |

### 웹의 판단 순서 (`inu-portal-web/src/utils/nativeBackRequest.ts`)

1. 등록된 오버레이/이탈방지 핸들러 (`backHandler`) — 바텀시트, 미저장 경고 등
2. 이 웹뷰 안에 쌓인 SPA 히스토리 (`pushState` 기반 모달 포함) → `history.back()`
3. 둘 다 없으면 `handled: false` → 셸이 웹뷰를 pop

SPA 깊이는 `window.history.length` 로 알 수 없다(서브페이지 웹뷰의 초기 length 는
0 이 아니다). 웹은 문서 진입 시점을 0 으로 두고 각 히스토리 엔트리의 state 에
깊이를 새겨 추적한다 — `inu-portal-web/src/utils/spaBackDepth.ts`.

### 셸의 처리 (`src/webview/backPolicy.ts`, `WebViewContainer.tsx`)

`BackHandler` 는 항상 이벤트를 소비하고(`return true`), 실제 동작은 웹의 응답이
온 뒤에 결정한다. 응답 대기는 `BACK_DELEGATION_TIMEOUT_MS`(350ms) 로 자른다 —
웹은 메시지 핸들러에서 동기로 답하므로 정상이면 수십 ms 다.

| 웹의 응답 | root | sub |
| --- | --- | --- |
| `handled: true` | 아무것도 안 함 | 아무것도 안 함 |
| `handled: false` | WebView 문서 히스토리가 있으면 `goBack()`, 없으면 "한 번 더 누르면 종료" | 화면 pop |
| 무응답(타임아웃) | WebView 히스토리가 있으면 `goBack()`, 없으면 종료 프롬프트 | 히스토리가 있으면 `goBack()`, 없으면 화면 pop |

무응답 폴백이 위임 도입 전의 동작과 같으므로, `checkBack` 을 모르는 구버전 웹이
올라와도 회귀하지 않는다.

## 제스처 설정

- `app.json` 의 `predictiveBackGestureEnabled: false` — Android 엣지 스와이프가
  `BackHandler` 를 거치게 한다. 켜 두면 시스템이 화면을 바로 pop 해서 하드웨어
  버튼과 동작이 갈린다(스와이프로는 모달이 안 닫히고 화면이 닫힘).
- `_layout.tsx` 의 `webview` 스크린 `gestureEnabled: false` — 네이티브 스택
  제스처는 페이지에 묻지 않고 화면을 닫으므로 양 플랫폼 모두에서 끈다.
- `WebViewContainer` 의 `backGestureGuard`(엣지 밴드 Pan 가드)는 그대로 둔다.
  스와이프 도중 WebView 가 텍스트 선택/드래그를 시작하는 별개의 문제를 막는다.

## 브릿지 계약

`intip-bridge` 의 `checkBack`(Native→Web) / `backResult`(Web→Native, `{ handled }`).
`channel.request()` / `channel.reply()` 의 id 상관관계를 그대로 쓴다.
