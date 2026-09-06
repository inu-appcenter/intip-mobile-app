#!/usr/bin/env bash
#
# 개발 빌드 설치 페이지(index.html)와 iOS 무선 설치용 manifest.plist를 만든다.
#
#   ./scripts/make-dev-install-page.sh --out-dir <dir> --base-url <url> \
#       --version 3.0.13 --build 26 --sha abc1234 [--ipa INTIP-dev.ipa] \
#       [--apk INTIP-dev.apk] [--icon icon.png] [--run-url <actions url>]
#
# --base-url은 이 빌드 디렉터리의 공개 URL이다(끝에 / 없이). 예:
#   https://media.inuappcenter.kr/intip-app-artifacts/dev/42-abc1234
#
# 페이지 안의 링크는 전부 절대 URL이라, 같은 index.html을 dev/index.html로
# 한 번 더 올려두면 "최신 빌드" 페이지로 그대로 쓸 수 있다.
#
# iOS는 itms-services:// 스킴으로 manifest.plist를 읽어 설치한다. manifest와
# IPA 모두 HTTPS여야 하고, 링크는 Safari에서 열어야 동작한다(인앱 브라우저 X).
set -euo pipefail

OUT_DIR=""; BASE_URL=""; VERSION=""; BUILD=""; SHA=""
IPA_NAME=""; APK_NAME=""; ICON_NAME=""; RUN_URL=""
BUNDLE_ID="${BUNDLE_ID:-kr.inuappcenter.intip.dev}"
TITLE="${TITLE:-INTIP Dev}"

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir)  OUT_DIR="$2"; shift 2 ;;
    --base-url) BASE_URL="${2%/}"; shift 2 ;;
    --version)  VERSION="$2"; shift 2 ;;
    --build)    BUILD="$2"; shift 2 ;;
    --sha)      SHA="$2"; shift 2 ;;
    --ipa)      IPA_NAME="$2"; shift 2 ;;
    --apk)      APK_NAME="$2"; shift 2 ;;
    --icon)     ICON_NAME="$2"; shift 2 ;;
    --run-url)  RUN_URL="$2"; shift 2 ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 1 ;;
  esac
done

: "${OUT_DIR:?--out-dir 필요}"; : "${BASE_URL:?--base-url 필요}"
: "${VERSION:?--version 필요}"; : "${BUILD:?--build 필요}"; : "${SHA:?--sha 필요}"
mkdir -p "$OUT_DIR"

BUILT_AT="$(date '+%Y-%m-%d %H:%M %Z')"

# ── manifest.plist (IPA가 있을 때만) ────────────────────────────────
if [ -n "$IPA_NAME" ]; then
  ICON_ITEMS=""
  if [ -n "$ICON_NAME" ]; then
    ICON_ITEMS="
        <dict>
          <key>kind</key><string>display-image</string>
          <key>url</key><string>${BASE_URL}/${ICON_NAME}</string>
        </dict>
        <dict>
          <key>kind</key><string>full-size-image</string>
          <key>url</key><string>${BASE_URL}/${ICON_NAME}</string>
        </dict>"
  fi
  cat > "$OUT_DIR/manifest.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key><string>software-package</string>
          <key>url</key><string>${BASE_URL}/${IPA_NAME}</string>
        </dict>${ICON_ITEMS}
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>${BUNDLE_ID}</string>
        <key>bundle-version</key><string>${VERSION}</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>${TITLE}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
EOF
fi

# ── index.html ──────────────────────────────────────────────────────
if [ -n "$IPA_NAME" ]; then
  # itms-services의 url 파라미터는 퍼센트 인코딩해야 한다.
  MANIFEST_ENC="$(printf '%s/manifest.plist' "$BASE_URL" \
    | sed -e 's|:|%3A|g' -e 's|/|%2F|g')"
  IOS_BLOCK="<a class=\"btn ios\" href=\"itms-services://?action=download-manifest&amp;url=${MANIFEST_ENC}\">iPhone에 설치</a>
      <p class=\"hint\">Safari에서 열어야 설치됩니다. 등록된 기기(UDID)에서만 설치할 수 있습니다.</p>"
else
  IOS_BLOCK="<p class=\"hint na\">이번 빌드에는 iOS 산출물이 없습니다.</p>"
fi

if [ -n "$APK_NAME" ]; then
  ANDROID_BLOCK="<a class=\"btn android\" href=\"${BASE_URL}/${APK_NAME}\">Android APK 내려받기</a>
      <p class=\"hint\">설치하려면 '출처를 알 수 없는 앱' 허용이 필요합니다.</p>"
else
  ANDROID_BLOCK="<p class=\"hint na\">이번 빌드에는 Android 산출물이 없습니다.</p>"
fi

RUN_BLOCK=""
[ -n "$RUN_URL" ] && RUN_BLOCK="<a class=\"link\" href=\"${RUN_URL}\">빌드 로그 보기</a>"

cat > "$OUT_DIR/index.html" <<EOF
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE} 설치</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; padding:2rem 1.25rem; font:16px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;
         background:#f6f7f9; color:#1b1d21; display:flex; justify-content:center; }
  @media (prefers-color-scheme: dark) { body { background:#15171a; color:#e8eaed; } }
  .card { width:100%; max-width:26rem; background:#fff; border-radius:16px; padding:1.75rem;
          box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06); }
  @media (prefers-color-scheme: dark) { .card { background:#1e2126; box-shadow:none; border:1px solid #2c3037; } }
  h1 { margin:0 0 .25rem; font-size:1.4rem; }
  .meta { margin:0 0 1.5rem; font-size:.875rem; opacity:.65; }
  .meta code { font-size:.85em; }
  .btn { display:block; text-align:center; text-decoration:none; font-weight:600;
         padding:.85rem 1rem; border-radius:10px; margin-top:1rem; color:#fff; }
  .btn.ios { background:#0a84ff; }
  .btn.android { background:#1db954; }
  .hint { margin:.5rem 0 0; font-size:.8rem; opacity:.6; }
  .hint.na { margin-top:1rem; }
  .link { display:inline-block; margin-top:1.5rem; font-size:.85rem; opacity:.6; }
  hr { border:0; border-top:1px solid rgba(128,128,128,.2); margin:1.75rem 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>${TITLE}</h1>
    <p class="meta">
      버전 ${VERSION} (빌드 ${BUILD})<br>
      커밋 <code>${SHA}</code> · ${BUILT_AT}
    </p>
    ${IOS_BLOCK}
    <hr>
    ${ANDROID_BLOCK}
    ${RUN_BLOCK}
  </div>
</body>
</html>
EOF

echo "📄 생성: $OUT_DIR/index.html"
[ -n "$IPA_NAME" ] && echo "📄 생성: $OUT_DIR/manifest.plist"
exit 0
