# 개발 · 배포 가이드

INTIP 네이티브 셸(`intip-mobile-app`)을 로컬에서 돌리고, 검증하고, 배포하는 데
필요한 실무 정보를 모은 문서입니다. 프로젝트의 구조와 설계 의도는
[README](../README.md)를 참고하세요.

- [1. 사전 준비](#1-사전-준비)
- [2. 로컬 실행](#2-로컬-실행)
- [3. 환경변수](#3-환경변수)
- [4. 검증 (lint · 타입체크 · 테스트)](#4-검증-lint--타입체크--테스트)
- [5. 브릿지 서브모듈 다루기](#5-브릿지-서브모듈-다루기)
- [6. 배포 파이프라인](#6-배포-파이프라인)
- [7. iOS 릴리스 보조 스크립트](#7-ios-릴리스-보조-스크립트)
- [8. 푸시 알림 테스트](#8-푸시-알림-테스트)
- [9. 디버깅 도구](#9-디버깅-도구)
- [10. 런타임 권한](#10-런타임-권한)

---

## 1. 사전 준비

### 저장소 클론 (서브모듈 포함)

브릿지 계약은 npm 패키지가 아니라 **git 서브모듈**(`packages/intip-bridge`)로
들어옵니다. 초기화하지 않으면 타입체크와 빌드가 모두 깨집니다.

```bash
git clone --recurse-submodules https://github.com/inu-appcenter/intip-mobile-app.git
# 이미 클론했다면
git submodule update --init
```

### Firebase 설정 파일 (필수)

푸시 알림에 `@react-native-firebase`를 쓰기 때문에, 번들 ID
`kr.inuappcenter.intip` / 패키지 `inu.appcenter.intip_android`에 대응하는 네이티브
설정 파일이 필요합니다. **시크릿이라 저장소에 커밋되지 않으며(gitignore)**, 빌드
전에 프로젝트 루트에 직접 넣어야 합니다.

| 파일 | 플랫폼 |
| --- | --- |
| `./GoogleService-Info.plist` | iOS |
| `./google-services.json` | Android |

> iOS는 RNFirebase 요구사항에 따라 `useFrameworks: "static"`
> (`expo-build-properties`)을 씁니다. AppDelegate 스위즐링 프록시는 기본값
> 그대로 두므로(`FirebaseAppDelegateProxyEnabled`를 끄지 않음) APNs 토큰이
> Firebase로 자동 전달됩니다.

---

## 2. 로컬 실행

네이티브 모듈을 쓰기 때문에 **Expo Go로는 실행할 수 없습니다.** 개발 빌드
(dev client)가 필요합니다.

```bash
npm install

# 네이티브 프로젝트 생성 (app.json / 네이티브 의존성을 바꾼 뒤에 실행)
npx expo prebuild

# 개발 빌드 설치 및 실행
npx expo run:ios       # 또는: npx expo run:android
```

개발 빌드가 기기에 한 번 설치된 뒤에는 `npx expo start`로 JS 번들만 갱신하면
됩니다.

- `ios/`, `android/`는 **CNG(Continuous Native Generation)** 산출물이라
  gitignore 대상입니다. 직접 수정하지 말고 `app.json` 또는 `plugins/` 아래의
  config plugin을 고치세요.
- 지원 플랫폼은 **iOS 15+ / Android**입니다. 웹은 대상이 아닙니다
  (`react-native-webview`와 네이티브 Firebase에 의존).

### config plugin

`plugins/` 아래 세 개의 로컬 config plugin이 prebuild 결과물을 손봅니다.

| plugin | 하는 일 |
| --- | --- |
| `withDefaultNotificationChannel.js` | Android 기본 알림 채널 등록 |
| `withAndroidReleaseSigning.js` | 릴리스 서명 설정 주입 |
| `withIOSManualSigning.js` | iOS 수동 서명(프로비저닝 프로파일 지정) |

### 로컬 Expo 모듈

`modules/intip-native-dialog`는 Android에서 기기 자체 다이얼로그 테마로 알림을
띄우기 위한 Kotlin 모듈입니다. `requireOptionalNativeModule`로 불러오므로,
모듈이 없는 바이너리(iOS, 또는 이 모듈보다 앞선 OTA 번들)에서는 RN의 `Alert`로
자동 폴백합니다.

---

## 3. 환경변수

백엔드 API 오리진만 환경변수로 주입합니다 (`src/config/env.ts`).

| 파일 | 값 | 사용 시점 |
| --- | --- | --- |
| `.env` | `EXPO_PUBLIC_API_BASE_URL=https://portal-dev.inuappcenter.kr` | 로컬/개발 빌드 |
| `.env.production` | `EXPO_PUBLIC_API_BASE_URL=https://portal.inuappcenter.kr` | 릴리스 번들 |

값이 없으면 개발 호스트로 폴백하고 경고를 남깁니다. 이 API 오리진은 셸이
웹뷰 없이 직접 호출하는 경로(FCM 토큰 등록, 토큰 리프레시)에서만 쓰입니다.

포털 URL 자체(`ROOT_URL`, `PORTAL_HOST`, 딥링크 허용 호스트)는 환경변수가 아니라
`src/webview/constants.ts`에 상수로 있습니다. `app.json`의
`ios.associatedDomains` / `android.intentFilters`, 그리고 웹 저장소가 서빙하는
도메인 연결 파일과 **함께** 맞춰야 하는 값이라, 한 곳에 모아두고 문서화하는 쪽을
택했습니다.

---

## 4. 검증 (lint · 타입체크 · 테스트)

```bash
npm run lint        # expo lint (eslint 9)
npm run typecheck   # tsc --noEmit
npm test            # jest
```

현재 **13개 스위트 / 128개 테스트**가 있습니다. 테스트 대상은 셸의 순수 로직
(브릿지 파싱, 경로 정규화, 뒤로가기 정책 결정, 알림·딥링크·공유 인텐트 →
목적지 매핑, 서브페이지 스택 조회, 다운로드 파일명 추출, 세션 스냅샷 직렬화)
입니다. 이 로직들이 React/네이티브 모듈에 의존하지 않도록 분리해 둔 덕분에
시뮬레이터 없이 검증됩니다.

tsc와 eslint는 서브모듈의 자체 저장소 파일은 건너뜁니다(`tsconfig.json`의
`exclude`, `eslint.config.js`의 `ignores: ["packages/**"]`). 우리가 실제로
import하는 소스만 import 추적을 통해 타입체크됩니다.

---

## 5. 브릿지 서브모듈 다루기

`packages/intip-bridge`는 npm 패키지가 아니라 **git 서브모듈이며 소스에서 직접
컴파일**됩니다(`WebViewContainer.tsx`의 상대 경로 import). `inu-portal-web`도
같은 방식으로 씁니다.

- `zod`가 이 저장소의 **직접 의존성**인 이유가 이것입니다 — 브릿지의
  `messages.ts`가 zod를 import하고, 그 소스가 앱 안에서 컴파일됩니다.
- **계약을 바꿀 때**: 브릿지 저장소에서 수정 → 커밋 → 푸시한 뒤, 여기에서 핀을
  올립니다.

  ```bash
  git submodule update --remote packages/intip-bridge
  git add packages/intip-bridge
  ```

  `inu-portal-web`에서도 동일하게 핀을 올립니다. npm publish도, 버전 bump도,
  `npm update`도 없습니다 — 핀은 semver가 아니라 git SHA입니다.
- 브릿지 소스는 **두 소비자의 strict tsconfig 양쪽에서** 컴파일되어야 합니다
  (예: 웹의 `noUnusedLocals`).
- CI도 서브모듈을 초기화해야 합니다 (`SUBMODULE_TOKEN`).

---

## 6. 배포 파이프라인

`.github/workflows/ci.yml`이 변경사항을 두 개의 레인으로 내보냅니다.

### 자동 — PR과 main 머지

| 이벤트 | 도는 것 |
| --- | --- |
| PR 생성/갱신 | `verify` (lint · 타입체크 · 테스트) |
| `main` 머지 | `verify` → `ota-publish` (EAS Update, `production` 채널) |

JS와 에셋 변경은 스토어 심사 없이 사용자에게 도달합니다.

### 수동 — Actions 탭에서 실행

**실행할 작업** 드롭다운에서 하나를 고릅니다.

| 실행할 작업 | 도는 잡 |
| --- | --- |
| `OTA publish` (기본값) | `verify` → `ota-publish` |
| `Android only release` | `android-release` (서명된 AAB + APK 아티팩트) |
| `iOS only release` | `ios-release` (IPA → TestFlight) |
| `Android + iOS release` | 두 릴리스 잡 모두 |
| `Verify only` | `verify`만 |

릴리스 빌드를 고르면 OTA는 함께 발행되지 않습니다. 네이티브가 바뀌었다는 건
`expo.version`이 올라갔다는 뜻이고, 그 업데이트는 어차피 아무에게도 도달하지
않기 때문입니다(아래 참고). 릴리스 잡 세 개는 `verify`를 건너뜁니다 — 그 커밋은
이미 PR/푸시 때 검증을 통과했을 것이므로, 느린 검증 컨테이너를 릴리스마다 다시
띄우지 않습니다. 릴리스 전에 확인이 필요하면 `Verify only`를 먼저 돌리세요.

### 버전을 올리면 왜 네이티브 빌드가 필요한가

`app.json`의 `runtimeVersion.policy: "appVersion"` 때문에, OTA는 **자신이 발행된
시점의 `expo.version`과 같은 버전으로 설치된 바이너리에만** 도달합니다.
`3.0.9` → `3.0.10`으로 올리는 순간, 다음 OTA는 `3.0.10` 네이티브 릴리스가
배포되기 전까지 **아무에게도 도달하지 않습니다.**

이건 버그가 아니라 의도된 안전장치입니다 — 네이티브 코드가 없는 구버전
바이너리 위에 그 코드를 호출하는 JS 번들이 내려앉는 것을 막습니다.

`ota-publish` 잡은 이걸 자동으로 지킵니다. 푸시에 `app.json`, `plugins/`,
`package.json`, `modules/`(로컬 Expo 모듈) 변경이 포함돼 있으면 발행을
**건너뛰고**, 그 사실을 잡 요약과 Mattermost 알림에 남깁니다. 변경이 JS
쪽뿐이라고 확신할 때만(예: `modules/` 아래 `.ts` 파일만 수정) `force_ota`
옵션으로 다시 실행하세요.

### 채널 매핑

`production` 채널은 이미 존재하고 `production` 브랜치를 가리킵니다. 잡은 채널이
없을 때만 다시 만듭니다. 이게 중요한 이유는, `eas update`가 만드는 것은
*브랜치*이지 *채널*이 아닌데 앱은 채널 이름으로 업데이트를 요청하기 때문입니다
(`updates.requestHeaders["expo-channel-name"]`). 매칭되는 채널 없이 발행된
업데이트는 **성공하지만 아무에게도 도달하지 않습니다.**

```bash
eas channel:view production
```

### 러너

모든 잡이 self-hosted 러너(macOS ARM64) 하나에서 돕니다. 이 저장소는 private이라
GitHub-hosted 러너는 분 단위로 과금되고 macOS는 단가가 10배라, iOS 빌드 한 번이
무료 분을 크게 깎아먹었습니다. 대신 알아둘 점:

- 러너가 꺼져 있으면 잡은 실패하지 않고 **큐에서 대기**합니다.
- 러너가 하나뿐이라 잡은 **순차 실행**됩니다.
- 아티팩트 스토리지는 여전히 GitHub 쿼터를 씁니다 → `retention-days`를 짧게
  유지합니다.

> 러너가 오프라인일 때는 `runs-on`을 GitHub-hosted로 임시 전환해 둡니다.
> `ci.yml` 상단 주석의 TEMP 표시를 확인하세요.

### 필요한 시크릿

| 시크릿 | 용도 |
| --- | --- |
| `EXPO_TOKEN` | EAS Update 발행 |
| `SUBMODULE_TOKEN` | `intip-bridge` 서브모듈 체크아웃 |
| `GOOGLE_SERVICES_JSON_BASE` / `GOOGLE_SERVICE_INFO_PLIST_BASE` | Firebase 설정 (base64) |
| `ANDROID_RELEASE_KEYSTORE_BASE`, `ANDROID_RELEASE_KEY_ALIAS`, `ANDROID_RELEASE_KEY_PASSWORD`, `ANDROID_RELEASE_STORE_PASSWORD` | Android 릴리스 서명 |
| `IOS_DISTRIBUTION_CERTIFICATE_P`, `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE`, `IOS_CI_KEYCHAIN_PASSWORD` | iOS 수동 서명 |
| `APP_STORE_CONNECT_API_KEY_BASE`, `APP_STORE_CONNECT_ISSUER_ID` | TestFlight 업로드 · buildNumber 조회 |
| `MATTERMOST_WEBHOOK` | 배포 결과 알림 |

디코딩된 시크릿 파일과 임시 keychain은 잡 마지막의 `if: always()` 스텝에서
삭제됩니다.

---

## 7. iOS 릴리스 보조 스크립트

`scripts/` 아래 네 개의 스크립트가 App Store Connect API를 직접 호출합니다
(의존성 없이 `node:crypto`로 RS256 JWT를 서명).

| 스크립트 | 하는 일 |
| --- | --- |
| `ios-next-build-number.js` | 이미 업로드된 최대 `CFBundleVersion` 조회 → +1을 stdout으로. CI가 prebuild 직전에 실행해 `EXPO_IOS_BUILD_NUMBER`로 넘기고, `app.config.js`가 `app.json` 값 대신 그걸 씁니다. buildNumber 중복(-19232 DUPLICATE) 거부를 막고, 커밋마다 손으로 올리던 작업을 없앴습니다. |
| `ios-check-provisioning-access.js` | 지금의 API 키가 capability 수정/프로파일 재발급 권한(Admin 롤)을 갖는지, 실제 App ID는 건드리지 않고 검증 |
| `ios-reissue-provisioning-profile.js` | App ID에 Associated Domains capability를 켜고 프로파일 재발급 (idempotent). 수동 서명이라 capability를 추가해도 기존 프로파일에는 반영되지 않기 때문에 필요 |
| `ios-cert-revoke.js` | 서명 인증서 조회/해지. 자동 서명 시절 CI가 매 실행마다 만들고 버린 인증서가 계정 한도를 채운 적이 있어 남겨둔 정리용 도구 |

---

## 8. 푸시 알림 테스트

FCM 콘솔은 임의의 `data` 키를 실을 수 없어서, 탭 라우팅 QA는 HTTP v1 API로
직접 발송해야 합니다.

```bash
node scripts/send-test-push.js --list                       # 시나리오 목록
node scripts/send-test-push.js general --token <FCM_TOKEN>  # 발송
```

서비스 계정 키는 `--key` 또는 `GOOGLE_APPLICATION_CREDENTIALS` 환경변수로
넘깁니다 (Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키).
시나리오는 서버의 `FcmMessageType` enum과 같은 이름을 쓰고, 각 시나리오는 클라이언트가
어떤 `NavIntent`로 판정해야 하는지를 기대값으로 갖고 있습니다.

### 딥링크 페이로드 규격

알림 `data`에 아래 키 중 하나를 실으면 해당 포털 경로로 이동합니다.

| 키 | 예시 |
| --- | --- |
| `path` | `/timetable` |
| `route` | `/bus` |
| `link` | 포털 전체 URL |

메인 탭 경로면 루트 웹뷰의 SPA를 그 경로로 이동시키고, 그 외에는 네이티브
서브페이지를 push하며, 허용 목록(`PUSH_EXTERNAL_HOSTS`)에 있는 외부 호스트면
인앱 브라우저로 넘깁니다. 그 외 호스트는 무시합니다 — 알림 페이로드는 신뢰
경계 밖이라, 임의 URL을 열게 만들 수 없어야 합니다.

---

## 9. 디버깅 도구

### 웹뷰 컨트롤러 (개발 빌드 전용)

기기를 흔들거나 세 손가락 롱프레스로 Expo 개발자 메뉴를 열면 INTIP 항목들이
있습니다(`src/webview/devMenu.ts`).

- 현재 스택 / 세션(로그인 여부, FCM 토큰) 조회
- 임의 URL 로드 — 보안 가드가 평소 외부 브라우저로 넘기는 URL도 이때는 허용
- 세션 스냅샷 저장/복원 — 어떤 포털 페이지가 스택에 열려 있는지를 디스크에
  JSON으로 남겼다가 되살립니다 (`src/webview/sessionStore.ts`)

인앱 컨트롤러 패널(`WebViewControllerPanel.tsx`)에서도 같은 기능을 씁니다.

### 웹 콘솔 릴레이 (개발 빌드 전용)

Safari/Chrome 원격 인스펙터는 붙는 타이밍이 불안정해서, 개발 빌드에서는 웹
컨텍스트의 `console.*`와 uncaught 에러를 네이티브(Metro) 로그로 중계합니다
(`src/webview/webConsole.ts`).

이 릴레이는 일부러 브릿지 채널을 타지 않습니다. 개발 도구일 뿐 네이티브↔웹
계약이 아니고, 계약에 넣으면 저장소 두 개의 스키마 bump를 강요하게 되기
때문입니다. 대신 자체 마커 키를 달고 `onMessage`에서 채널보다 먼저 걷어냅니다.

---

## 10. 런타임 권한

| 권한 | 요청 시점 |
| --- | --- |
| 알림 | 첫 실행. Android 13+는 `POST_NOTIFICATIONS`를 `react-native-permissions`로 명시 요청, iOS는 Firebase messaging을 통해 APNs 프롬프트 |
| 카메라 | 별도 프라이밍 없음 — 두 웹뷰 엔진 모두 `getUserMedia` 호출 시점에 OS에 직접 요청 |
| 위치 | **지연 프라이밍** — 페이지가 실제로 `navigator.geolocation`을 호출한 첫 순간에 앱 레벨 권한을 요청하고, 앱 세션당 한 번만 합니다. iOS WKWebView의 geolocation은 앱 레벨 승인이 선행되어야 동작합니다 |

`app.json`의 `iosPermissions` 목록이 어떤 권한 핸들러 pod을 컴파일할지
결정합니다. 프라이밍 시점을 바꾸려면
`src/components/WebViewContainer.tsx`의 `primeLocationPermission`을 보세요.
