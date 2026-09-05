// app.json은 그대로 진실의 출처(source of truth)로 남긴다. Expo는 app.config.js가
// 있으면 app.json을 자동으로 병합하지 않고 이 파일만 쓰므로, 여기서 app.json을
// 직접 불러와 펼친 뒤 필요한 값만 조건부로 덮어쓴다.
//
// 배경 1: xcodebuild archive → altool 업로드 흐름에서 CFBundleVersion이 App Store
// Connect에 이미 올라간 값과 같으면 -19232/DUPLICATE로 거부된다. CI가 prebuild
// 직전에 scripts/ios-next-build-number.js로 "다음 buildNumber"를 계산해
// EXPO_IOS_BUILD_NUMBER 환경변수로 넘기면 여기서 app.json의 값 대신 그걸 쓴다.
// 로컬 개발 등 그 환경변수가 없을 때는 app.json의 ios.buildNumber를 그대로 쓴다.
//
// 배경 2: 내부 배포용 개발 빌드(운영 앱과 별도 설치)는 APP_VARIANT=development로
// 빌드한다. eas.json의 build 프로필이 아니라 .github/workflows/dev-build.yml
// (dev 브랜치 push 트리거, 자체 self-hosted 러너)이 이 환경변수를 세팅한다 —
// 이 저장소는 `eas build`를 쓰지 않고, EAS는 OTA(EAS Update) 경로 전용이다.
// 개발 변형은 운영 앱과 나란히 설치될 수 있어야 하므로 bundle id/package,
// 앱 아이콘, Firebase 설정, associated domain(딥링크), URL scheme, 푸시
// 환경까지 갈아끼운다. 단 `expo.name`(및 android/ios 타깃 이름)은 그대로
// 둔다 — plugins/withIOSManualSigning.js와 withAndroidReleaseSigning.js가
// `expo prebuild`가 생성하는 타깃/파일을 이름으로 앵커링하고 있어서, 이름이
// 바뀌면 두 서명 플러그인이 조용히 no-op으로 빠진다. 홈 화면 표시 이름만
// CFBundleDisplayName(iOS)과 strings.xml의 app_name(Android, 아래 로컬
// plugins/withDevAppLabel.js)으로 따로 바꾼다.
const { expo } = require("./app.json");

const isDevVariant = process.env.APP_VARIANT === "development";

module.exports = () => ({
  expo: {
    ...expo,
    ios: {
      ...expo.ios,
      buildNumber: process.env.EXPO_IOS_BUILD_NUMBER ?? expo.ios.buildNumber,
      ...(isDevVariant && {
        bundleIdentifier: "kr.inuappcenter.intip.dev",
        icon: "./assets/icon-dev.icon",
        googleServicesFile: "./GoogleService-Info-Dev.plist",
        associatedDomains: ["applinks:intip-test.pages.dev"],
        entitlements: {
          ...expo.ios.entitlements,
          "aps-environment": "development",
        },
        infoPlist: {
          ...expo.ios.infoPlist,
          CFBundleDisplayName: "INTIP Dev",
        },
      }),
    },
    android: {
      ...expo.android,
      ...(isDevVariant && {
        package: "inu.appcenter.intip_android.dev",
        googleServicesFile: "./google-services-dev.json",
        adaptiveIcon: {
          foregroundImage: "./assets/images/Dev App Icon.png",
          backgroundImage: "./assets/images/android-icon-background.png",
        },
        intentFilters: [
          {
            action: "VIEW",
            autoVerify: true,
            data: [{ scheme: "https", host: "intip-test.pages.dev" }],
            category: ["BROWSABLE", "DEFAULT"],
          },
        ],
      }),
    },
    updates: {
      ...expo.updates,
      ...(isDevVariant && {
        requestHeaders: { "expo-channel-name": "development" },
      }),
    },
    ...(isDevVariant && { scheme: "intipmobileappdev" }),
    plugins: [...expo.plugins, ...(isDevVariant ? ["./plugins/withDevAppLabel"] : [])],
  },
});
