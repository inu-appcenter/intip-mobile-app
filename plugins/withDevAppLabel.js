/**
 * 개발 변형(APP_VARIANT=development)에서만 로드되는 플러그인(app.config.js
 * 참고). Android 홈 화면 앱 이름(res/values/strings.xml의 app_name)만
 * "INTIP Dev"로 바꾼다.
 *
 * `expo.name`을 직접 바꾸지 않는 이유: expo prebuild가 그 값으로 android/
 * 프로젝트 자체를 생성하고, plugins/withAndroidReleaseSigning.js는 생성된
 * build.gradle의 고정된 앵커 텍스트에 의존한다(앱 이름이 아니라 Gradle
 * 템플릿 구조에 앵커링돼 있어 실제로는 영향 없지만, iOS 쪽 타깃 이름
 * 앵커링과 짝을 맞추기 위해 이름 자체는 항상 고정해 둔다 — app.config.js
 * 상단 주석 참고). 대신 표시 이름만 이 플러그인으로 덧씌운다.
 */
const { withStringsXml } = require("expo/config-plugins");

module.exports = function withDevAppLabel(config) {
  return withStringsXml(config, (cfg) => {
    const strings = cfg.modResults.resources.string ?? [];
    const appName = strings.find((s) => s.$.name === "app_name");
    if (appName) {
      appName._ = "INTIP Dev";
    } else {
      strings.push({ $: { name: "app_name" }, _: "INTIP Dev" });
    }
    cfg.modResults.resources.string = strings;
    return cfg;
  });
};
