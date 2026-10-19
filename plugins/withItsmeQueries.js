/**
 * Android 11+ 패키지 가시성: 잇츠미(`id.itsme.mobile`)를 `<queries>` 에 선언한다.
 *
 * 선언이 없으면 `getLaunchIntentForPackage` 가 설치돼 있어도 null 을 돌려줘
 * `expo-intent-launcher` 의 `openApplication` 이 미설치처럼 던지고,
 * `src/itsme/openItsme.ts` 가 매번 Play 스토어로 보낸다.
 * 패키지명은 `src/itsme/itsmeLink.ts` 의 `ITSME_ANDROID_PACKAGE` 와 맞춘다.
 */
const { withAndroidManifest } = require("expo/config-plugins");

const ITSME_ANDROID_PACKAGE = "id.itsme.mobile";

/** manifest 객체에 `<queries><package android:name=…/></queries>` 를 한 번만 넣는다. */
function addPackageQuery(manifest, packageName) {
  manifest.queries = manifest.queries ?? [];
  if (manifest.queries.length === 0) manifest.queries.push({});
  const queries = manifest.queries[0];
  queries.package = queries.package ?? [];
  const already = queries.package.some((entry) => entry.$?.["android:name"] === packageName);
  if (!already) queries.package.push({ $: { "android:name": packageName } });
  return manifest;
}

function withItsmeQueries(config) {
  return withAndroidManifest(config, (cfg) => {
    addPackageQuery(cfg.modResults.manifest, ITSME_ANDROID_PACKAGE);
    return cfg;
  });
}

module.exports = withItsmeQueries;
module.exports.addPackageQuery = addPackageQuery;
module.exports.ITSME_ANDROID_PACKAGE = ITSME_ANDROID_PACKAGE;
