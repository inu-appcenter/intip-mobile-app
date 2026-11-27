# 스마트캠퍼스 알림 재분류 (notification relay) — 초안

스마트캠퍼스 앱이 모든 공지를 한 채널로 쏟아내는 문제를, INTIP이 그 알림을 받아 **사용자가 등록한
키워드로 분류**한 뒤 **카테고리별 INTIP 알림**으로 다시 보내는 방식으로 푼다. 분류는 전부 기기 안에서
하고, 알림 내용은 서버로 보내지 않는다.

| | Android | iOS 27+ |
|---|---|---|
| 알림을 받는 방법 | `NotificationListenerService` (앱이 직접) | 단축어 자동화 "알림을 받았을 때" → INTIP App Intent |
| 원본 알림 | 앱이 지움 (`cancelNotification`) | 지울 수 없음 → 사용자가 미리 조용하게 설정 |
| 카테고리 구분 | 카테고리별 알림 채널 (시스템 설정에서 개별 무음/차단) | `threadIdentifier`로 묶기 + 중요도별 소리/`passive` |
| 사용자 설정 | 알림 접근 허용 1회 | 자동화 직접 만들기 (앱이 대신 못 만든다) |
| 탭했을 때 | 원본의 `contentIntent` → 스마트캠퍼스 해당 화면 | INTIP 열림 (원본 딥링크를 모름) |

## 구성

```
modules/intip-notification-relay/
  src/config.ts                 설정 스키마, 기본 카테고리, 기준 분류기(classifyNotification), 검증
  index.ts                      JS API (NotificationRelay.saveConfig / getRecent / openListenerSettings …)
  android/…/RelayListenerService.kt   알림 수신 → 분류 → 원본 삭제 → 재발송
  android/…/RelayConfig.kt            설정 파싱 + 분류기 (config.ts와 같은 규칙)
  android/…/RelayNotifier.kt          카테고리 채널 동기화, 알림 발송, 최근 내역
  ios/IntipNotificationRelayModule.swift   설정을 UserDefaults에 저장만 함
plugins/notification-relay-ios/RelayNotificationIntent.swift   App Intent + 분류기 (메인 앱 타깃)
plugins/withNotificationRelayIntent.js                          위 파일을 메인 앱 타깃에 넣는 플러그인
```

분류 규칙(공백 제거 + 소문자 비교, 위 카테고리의 첫 매치가 이김, 안 걸리면 fallback)은
TS·Kotlin·Swift 세 곳에 있다. 바꿀 때는 `src/__tests__/config.test.ts` 케이스부터 늘리고 셋 다 고친다.
JS 런타임 없이 돌아야 해서(Android 리스너는 앱이 꺼져 있어도 바인드되고, App Intent는 백그라운드
실행) 네이티브 쪽 중복은 피할 수 없다.

## Android

1. 설정 화면에서 `NotificationRelay.openListenerSettings()` → 사용자가 "INTIP 알림 분류" 허용.
2. `getActiveNotificationSources()`로 지금 떠 있는 알림의 패키지 목록을 보여 주고 스마트캠퍼스를 고르게
   한다(패키지명을 아직 모른다 — **TODO: 실기기에서 확인 후 기본값으로 박기**).
3. `saveConfig({ ...DEFAULT_RELAY_CONFIG, enabled: true, android: { sourcePackages: [pkg], cancelOriginal: true } })`.
4. 사용자에게 **스마트캠퍼스 알림을 "끄기"가 아니라 "무음"으로** 바꾸라고 안내한다. 원본이 지워지기 전에
   소리가 한 번 날 수 있고, 완전히 끄면 리스너에도 안 온다.

주의:
- **사이드로드(내부 배포 APK)**: Android 13+는 스토어 밖에서 설치한 앱의 알림 접근을 "제한된 설정"으로
  막는다. 앱 정보 > ⋮ > 제한된 설정 허용을 먼저 해야 토글이 켜진다. 스토어 설치본은 해당 없음.
- **Play 정책**: 신고가 필요한 제한 권한은 아니지만 User Data 정책상 알림 내용에 접근한다는 사실을
  눈에 띄게 알리고 동의받는 화면이 필요하다. 기기 밖 전송이 없다는 점을 명시.
- **OEM 배터리 최적화**: 리스너가 끊기면 앱 실행 시 `requestRebind()`.
- **탭 동작**: 원본 `contentIntent`를 그대로 단다. Android 14+ 백그라운드 액티비티 실행 제한에서 알림
  탭은 허용되는 경로지만 기기별로 확인할 것.

## iOS 27+

iOS 27 단축어에 "알림을 받았을 때" 자동화 트리거가 생겼다(앱 지정, 제목/부제/내용 필터 가능). 앱이 다른
앱 알림을 읽는 API는 여전히 없으므로 사용자가 자동화를 직접 만든다:

1. 단축어 > 자동화 > 새로 만들기 > 알림 > 앱: 인천대학교 스마트캠퍼스, **즉시 실행**.
2. 동작: INTIP의 **"알림 분류해서 다시 보내기"** — 제목·내용에 단축어 입력(알림)의 제목·내용을 넣는다.
3. 스마트캠퍼스 원본을 조용하게: 설정 > 알림 > 스마트캠퍼스에서 배너·소리 끄기(알림 센터만 켜 둠).
   집중 모드에 넣는 방법도 되지만 그러면 그 집중 모드를 항상 켜 둬야 한다.

**실기기에서 꼭 확인할 것 (초안의 가정)**
- [ ] 자동화가 알림의 제목/내용을 변수로 넘겨주는가 (필터는 확실, 변수 전달은 문서로 확인 못 함).
      안 되면 자동화 필터(제목에 "휴강" 포함 등)로 카테고리마다 자동화를 따로 만드는 수밖에 없다.
- [ ] 배너·소리를 끈(알림 센터만) 스마트캠퍼스 알림에도 트리거가 도는가. 집중 모드로 무음된 알림은?
- [ ] "즉시 실행"이 확인 없이 돌고, 잠금 상태에서도 도는가.
- [ ] `openAppWhenRun = false` 인텐트가 앱을 UI 없이 띄워 알림을 보내는 데 걸리는 시간 / 실패 시 동작.
      RN 초기화 비용이 문제면 App Intents Extension 타깃으로 옮긴다(설정 공유에 App Group 필요).

단축어만으로도(INTIP 없이) "필터 + 알림 보기" 조합이 되지만, 그 알림은 단축어 앱 이름으로 오고 카테고리
묶기·키워드 일괄 관리가 안 된다. INTIP 인텐트를 쓰는 이유는 그 둘이다.

## 남은 일

- [ ] 설정 UI: 웹(inu-portal-web)에 만들지 네이티브 화면으로 만들지 결정. 웹이면 intip-bridge에 메시지 추가.
- [ ] 스마트캠퍼스 Android 패키지명, 실제 알림 문구 샘플 수집 → 기본 카테고리/키워드 다듬기.
- [ ] Android 실기기 테스트 (삼성/픽셀), iOS 27 실기기 테스트 (위 체크리스트).
- [ ] Play 동의 화면 문구.
