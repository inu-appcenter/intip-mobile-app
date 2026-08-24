#!/usr/bin/env bash
# 로컬에서 서명된 릴리스 AAB/APK 를 만든다.
#
# plugins/withAndroidReleaseSigning.js 가 android/app/build.gradle 의
# signingConfigs.release 를 System.getenv(...) 로 채워두기 때문에, Gradle 을
# 그냥 실행하면 storePassword 가 null 이라
#   SigningConfig "release" is missing required property "storePassword"
# 로 죽는다. 이 스크립트는 .env.android.local 을 export 한 뒤 Gradle 을 부른다.
# CI 는 같은 이름의 GitHub Secrets 를 쓰므로 이 스크립트가 필요 없다.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.android.local"
if [ ! -f "$ENV_FILE" ]; then
  echo "$ENV_FILE 이 없다. 키스토어 자격증명을 채운 뒤 다시 실행할 것." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

missing=()
for v in ANDROID_RELEASE_STORE_PASSWORD ANDROID_RELEASE_KEY_ALIAS ANDROID_RELEASE_KEY_PASSWORD; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "$ENV_FILE 에 값이 비어 있다: ${missing[*]}" >&2
  exit 1
fi

KEYSTORE="${ANDROID_RELEASE_STORE_FILE:-intip.jks}"
if [ ! -f "$KEYSTORE" ]; then
  echo "키스토어를 찾을 수 없다: $KEYSTORE" >&2
  exit 1
fi

if [ ! -d android ]; then
  echo "android/ 가 없다. 먼저 'npm run prebuild:clean' 을 돌릴 것." >&2
  exit 1
fi

# x86/x86_64 는 에뮬레이터 전용 ABI — Play 에 올라가는 바이너리엔 영향 없이
# 네이티브 컴파일 시간을 절반 가까이 줄인다 (CI 와 동일한 플래그).
cd android
exec ./gradlew --no-daemon --build-cache \
  assembleRelease bundleRelease \
  -PreactNativeArchitectures=armeabi-v7a,arm64-v8a "$@"
