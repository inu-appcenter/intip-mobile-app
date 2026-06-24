# INTIP — React Native App Specification

> Migration spec for rebuilding the **INTIP** (Incheon National University Portal) iOS app as a
> cross-platform **React Native** application.
>
> This document is derived from the existing native SwiftUI/WebKit implementation
> (`INTIP/INTIP/*.swift`). It captures every behavior the current app provides so the new
> React Native app reaches feature parity (and adds Android support for free).

---

## 1. Overview

INTIP is a **hybrid (WebView-hosted) app**. All UI and business logic live in the web frontend
served at `https://intip.inuappcenter.kr`. The native shell provides:

- A full-screen WebView pointing at the portal.
- A **JavaScript ↔ Native bridge** for login detection, route awareness, push tokens, and cache control.
- **Push notifications** (Firebase Cloud Messaging + APNs).
- Native capabilities the web cannot do alone: cache wiping, file downloads, external-link handoff,
  network reachability checks, OS permission prompts.

The React Native app keeps the same architecture: a `WebView` component as the root, with a thin
native/JS bridge layer around it. **No portal UI is re-implemented natively.**

|            | Current (Swift)                             | Target (React Native)              |
| ---------- | ------------------------------------------- | ---------------------------------- |
| UI host    | `WKWebView` (SwiftUI `UIViewRepresentable`) | `react-native-webview`             |
| Push       | FirebaseMessaging (CocoaPods)               | `@react-native-firebase/messaging` |
| Platforms  | iOS 15+                                     | iOS 15+ **and** Android            |
| Web target | `https://intip.inuappcenter.kr`             | same                               |

---

## 2. Required Features (parity — must implement)

These mirror behaviors that already exist in the Swift app and **must** be reproduced.

### 2.1 Root WebView

- Loads `https://intip.inuappcenter.kr` on launch.
- Full screen; ignores the bottom safe-area inset (content extends to the bottom edge).
  - Swift ref: `ContentView.swift` → `.ignoresSafeArea(edges: .bottom)`,
    `WebView.swift` → `scrollView.contentInsetAdjustmentBehavior = .never`.
- Inline media playback enabled — videos must **not** auto-fullscreen/auto-expand.
  - Swift ref: `config.allowsInlineMediaPlayback = true`.
  - RN: `<WebView allowsInlineMediaPlayback mediaPlaybackRequiresUserAction />`.
- Background color follows the OS color scheme while the web content loads:
  - Light: `#f7f7f7` · Dark: `#1C1C1E`.

### 2.2 Cache control

- **On every app launch**: clear memory + disk cache, _then_ load the page.
  - Swift ref: `clearCacheAndLoad(...)`.
  - RN: `<WebView cacheEnabled={false} />` plus an explicit cache clear on mount
    (`webViewRef.clearCache(true)` on Android; `cacheEnabled={false}` + cache-busting on iOS).
- **On demand** ("화면 업데이트"): when the web calls `requestAppUpdate`, show a confirm dialog,
  then clear cache and reload **while preserving login** (localStorage / cookies must survive).
  - Dialog copy: title `화면 업데이트`,
    message `로그인 정보는 유지되며, 최신 화면으로 업데이트를 진행합니다.`
  - Important: only memory + disk **cache** are wiped, never localStorage/cookies.

### 2.3 Push notifications (FCM)

- Request notification permission on first launch (alert + badge + sound).
- Register for remote notifications; feed the APNs token to Firebase.
- Show notifications in the foreground as banners (with badge + sound).
- After the page finishes loading **and** after a login-success signal, fetch the FCM token and
  push it into the web context by calling:
  ```js
  window.onReceiveFcmToken && window.onReceiveFcmToken("<fcm-token>");
  ```
- Retry token fetch up to **3 times** with a 1s backoff if it isn't ready yet.
  - Swift ref: `fetchFcmToken(for:retry:)`, `postToken(_:)`.

### 2.4 JS ↔ Native bridge

The web frontend already speaks this protocol. Keep the **exact** message names.

**Web → Native** (current Swift `WKScriptMessageHandler` names):

| Message            | Payload                             | Native action                                                    |
| ------------------ | ----------------------------------- | ---------------------------------------------------------------- |
| `loginSuccess`     | `'ok'`                              | Re-fetch FCM token and post it to the web (`onReceiveFcmToken`). |
| `routeChange`      | `window.location.pathname` (string) | Update back-gesture rules (see 2.5).                             |
| `requestAppUpdate` | —                                   | Show confirm dialog → cache clear + reload (see 2.2).            |

> In `react-native-webview` all three arrive through a single `onMessage` handler. Bridge
> messages should be sent as `window.ReactNativeWebView.postMessage(JSON.stringify({type, payload}))`.
> An **injected script** must reproduce the current behavior:
>
> - On load, if `localStorage.getItem('tokenInfo')` exists → post a `loginSuccess` message.
> - Patch `history.pushState` / `history.replaceState` and listen to `popstate` to post
>   `routeChange` with the current `pathname` (the existing `WebViewScripts.routeObserver`).

**Native → Web:**

- `window.onReceiveFcmToken('<token>')` — deliver the FCM token (see 2.3).

### 2.5 Back-gesture / navigation rules

- The interactive back (swipe) gesture is **disabled** on these "root tab" paths:
  `/home`, `/bus`, `/timetable`, `/mypage`.
- On every `routeChange`, enable the gesture unless the current path is in that set.
  - Swift ref: `restrictedPaths`, `handleRouteChange(...)`.
- Android: also intercept the hardware back button with the same rule (and exit on the root tabs
  or show a "press again to exit" pattern — **new**, decide during implementation).

### 2.6 External links

- Any navigation whose URL is **not** under `intip.inuappcenter.kr` opens in the **system browser**,
  not inside the WebView.
  - Swift ref: `createWebViewWith` / `UIApplication.shared.open(url)`.
  - RN: `onShouldStartLoadWithRequest` → if host ≠ portal, `Linking.openURL(url)` and return `false`.

### 2.7 File downloads

- Downloadable responses are saved to the device, then an alert confirms:
  title `다운로드 완료`, message `파일이 저장되었습니다.`
  - Swift ref: `WKDownloadDelegate` methods.
  - RN: handle via `onFileDownload` (iOS) and `react-native-blob-util` / scoped storage (Android).

### 2.8 Network reachability

- On launch, check connectivity. If offline, show an alert:
  - Title: `네트워크 연결 실패`
  - Message: `네트워크가 연결되어 있지 않습니다. 연결 후 다시 시도해주세요.`
  - Buttons: `재시도` (re-check) and `앱 종료` (exit — iOS only; on Android prefer "닫기").
  - Do not render the WebView until connected.
  - Swift ref: `ContentView.checkNetwork()` (`SystemConfiguration` reachability).
  - RN: `@react-native-community/netinfo`.

### 2.9 Native dialogs for web `alert` / `confirm`

- JavaScript `alert()` and `confirm()` should present native dialogs with Korean buttons
  (`확인` / `취소`).
  - Swift ref: `AlertHelper`, `runJavaScriptAlertPanel...` / `runJavaScriptConfirmPanel...`.
  - RN: `react-native-webview` shows these natively by default; verify button localization.

---

## 3. Permissions Required

Carry over the exact usage strings (Korean) the current app declares.

| Permission             | Purpose                                   | iOS key                                                                                                    | Android                                          |
| ---------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Push notifications     | FCM / portal alerts                       | `aps-environment`, `UIBackgroundModes: remote-notification, fetch`                                         | `POST_NOTIFICATIONS` (Android 13+)               |
| Camera                 | Photo capture for uploads                 | `NSCameraUsageDescription` = `이 앱은 사진 촬영을 위해 카메라 접근 권한이 필요합니다.`                     | `CAMERA`                                         |
| Photo Library (read)   | Image upload                              | `NSPhotoLibraryUsageDescription` = `이 앱은 사진 업로드를 위해 사진첩 접근 권한이 필요합니다.`             | `READ_MEDIA_IMAGES`                              |
| Photo Library (add)    | Save captured photos                      | `NSPhotoLibraryAddUsageDescription` = `이 앱은 촬영한 사진을 저장하기 위해 사진첩 접근 권한이 필요합니다.` | `WRITE_EXTERNAL_STORAGE` (≤ API 29)              |
| Location (when in use) | Campus map — show user position/direction | `NSLocationWhenInUseUsageDescription` = `캠퍼스맵 내 위치 표시를 위해 위치 권한이 필요합니다.`             | `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` |
| Network access         | Load portal                               | (ATS: `NSAllowsArbitraryLoads = true` — review whether still needed)                                       | `INTERNET`                                       |

> ⚠️ **App Transport Security**: the current app sets `NSAllowsArbitraryLoads = true`. The portal is
> HTTPS, so prefer removing this and adding a narrow exception only if a sub-resource requires it.

---

## 4. Portal Routes (web-owned, for context)

These are the screens the portal renders. They are **not** built natively, but the shell reacts to them.

| Path         | Screen                      | Native relevance                                         |
| ------------ | --------------------------- | -------------------------------------------------------- |
| `/home`      | Home                        | Root tab — back gesture disabled                         |
| `/bus`       | Bus info (인입런 / shuttle) | Root tab — back gesture disabled                         |
| `/timetable` | Timetable                   | Root tab — back gesture disabled                         |
| `/mypage`    | My page / profile           | Root tab — back gesture disabled                         |
| campus map   | Campus map                  | Uses **location + heading** permission                   |
| login        | Login                       | Emits `loginSuccess`; stores `tokenInfo` in localStorage |

`tokenInfo` shape (localStorage, JSON):

```ts
interface TokenInfo {
  accessToken: string;
  accessTokenExpiredTime: string;
  refreshToken: string;
  refreshTokenExpiredTime: string;
}
```

---

## 5. Suggested Tech Stack

| Concern               | Library                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| Framework             | React Native (latest stable) — bare or Expo (dev-client, since native Firebase is needed) |
| WebView               | `react-native-webview`                                                                    |
| Push                  | `@react-native-firebase/app` + `@react-native-firebase/messaging`                         |
| Notifications display | `notifee` (rich foreground notifications)                                                 |
| Connectivity          | `@react-native-community/netinfo`                                                         |
| Permissions           | `react-native-permissions`                                                                |
| External links        | `Linking` (core)                                                                          |
| Downloads (Android)   | `react-native-blob-util`                                                                  |
| Language              | TypeScript                                                                                |

Firebase config carries over: `GoogleService-Info.plist` (iOS) is already present; add
`google-services.json` for Android. The `FirebaseAppDelegateProxyEnabled = NO` setting from the
current Info.plist should be re-evaluated (RNFirebase typically wants the swizzling/proxy default).

---

## 6. Suggested Project Structure

```
inu-portal-rn/
├── App.tsx                  # Root: NetInfo gate → <PortalWebView/>
├── src/
│   ├── components/
│   │   └── PortalWebView.tsx    # WebView + bridge wiring
│   ├── webview/
│   │   ├── injectedScript.ts    # routeObserver + tokenInfo login detect
│   │   ├── bridge.ts            # onMessage router (loginSuccess/routeChange/requestAppUpdate)
│   │   └── constants.ts         # ROOT_URL, RESTRICTED_PATHS, dialog strings
│   ├── push/
│   │   └── messaging.ts         # FCM init, token fetch+retry, postToken
│   ├── native/
│   │   ├── cache.ts             # clear cache helpers
│   │   ├── network.ts           # NetInfo wrapper
│   │   └── downloads.ts         # file download handling
│   └── theme.ts                 # light/dark background colors
├── ios/  android/               # native projects
└── docs/REACT_NATIVE_APP.md     # this file
```

---

## 7. Implementation Checklist

- [ ] Bootstrap RN (TypeScript) project; add iOS + Android targets.
- [ ] Add `react-native-webview`; render full-screen WebView at `ROOT_URL`.
- [ ] Inject `routeObserver` + `tokenInfo` login-detection script (`injectionTime: documentEnd`).
- [ ] Implement `onMessage` bridge router for `loginSuccess`, `routeChange`, `requestAppUpdate`.
- [ ] Back-gesture / hardware-back rules using `RESTRICTED_PATHS`.
- [ ] External-link handoff via `onShouldStartLoadWithRequest` + `Linking`.
- [ ] Inline media playback (no video auto-fullscreen).
- [ ] Cache: clear-on-launch + load; on-demand confirm→clear→reload (preserve login).
- [ ] Integrate RNFirebase messaging; request permission; foreground notifications.
- [ ] FCM token fetch (3× retry) → `window.onReceiveFcmToken(token)` after load + on login.
- [ ] APNs/notification entitlements + background modes (iOS); `POST_NOTIFICATIONS` (Android).
- [ ] NetInfo launch gate with retry / exit alert.
- [ ] File download handling + "다운로드 완료" confirmation.
- [ ] Color-scheme background (`#f7f7f7` / `#1C1C1E`).
- [ ] Declare all permissions with the Korean usage strings (§3).
- [ ] Re-evaluate `NSAllowsArbitraryLoads` and `FirebaseAppDelegateProxyEnabled`.
- [ ] Port app icons / launch screen / assets.

---

## 8. Open Questions / Decisions

1. **Expo vs. bare RN** — EXPO (latest) with dev-client is chosen.
2. **Android back behavior on root tabs** — exit app, or "press back again to exit"? (new behavior, no iOS precedent).
3. **ATS** — can `NSAllowsArbitraryLoads` be dropped? Audit portal sub-resources.
4. **Download UX on Android** — scoped storage target dir + notification?
5. **Deep links / push tap routing** — should tapping a notification navigate to a specific portal route? (Current app does nothing on tap.) - YES!

```

```


