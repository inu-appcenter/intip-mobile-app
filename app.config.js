// app.json은 그대로 진실의 출처(source of truth)로 남긴다. Expo는 app.config.js가
// 있으면 app.json을 자동으로 병합하지 않고 이 파일만 쓰므로, 여기서 app.json을
// 직접 불러와 펼친 뒤 ios.buildNumber만 조건부로 덮어쓴다.
//
// 배경: xcodebuild archive → altool 업로드 흐름에서 CFBundleVersion이 App Store
// Connect에 이미 올라간 값과 같으면 -19232/DUPLICATE로 거부된다. CI가 prebuild
// 직전에 scripts/ios-next-build-number.js로 "다음 buildNumber"를 계산해
// EXPO_IOS_BUILD_NUMBER 환경변수로 넘기면 여기서 app.json의 값 대신 그걸 쓴다.
// 로컬 개발 등 그 환경변수가 없을 때는 app.json의 ios.buildNumber를 그대로 쓴다.
const { expo } = require("./app.json");

module.exports = () => ({
  expo: {
    ...expo,
    ios: {
      ...expo.ios,
      buildNumber: process.env.EXPO_IOS_BUILD_NUMBER ?? expo.ios.buildNumber,
    },
  },
});
