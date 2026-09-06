#!/usr/bin/env bash
#
# Garage(s3.inuappcenter.kr) 왕복 검증 스크립트.
#
# 확인하는 것:
#   1. path-style PUT  — 와일드카드 DNS가 없어서 vhost-style은 못 쓴다
#   2. HEAD/GET 후 sha256 비교 — 바이트가 온전히 왕복하는지
#   3. media.inuappcenter.kr/<버킷>/<키> 공개 다운로드 — Caddy의 Host
#      재작성(경로 첫 세그먼트 → 버킷)과 Garage website 노출이 맞물리는지
#   4. Range 요청 — iOS 무선 설치(itms-services)가 Range를 쓰므로,
#      Cloudflare를 통과해서도 206이 오는지 확인해야 한다
#
# 사용법:
#   ./scripts/s3-smoke-test.sh [업로드할_파일]
#   KEEP=1 ./scripts/s3-smoke-test.sh   # 검증 후 객체를 지우지 않음
#
# 크레덴셜은 아래 placeholder를 직접 채우거나, ~/.intip-s3.env 에 넣어둔다:
#   AWS_ACCESS_KEY_ID=GK...
#   AWS_SECRET_ACCESS_KEY=...
set -euo pipefail

# ── 설정 ────────────────────────────────────────────────────────────
S3_ENDPOINT="${S3_ENDPOINT:-https://s3.inuappcenter.kr}"
WEB_BASE="${WEB_BASE:-https://media.inuappcenter.kr}"
BUCKET="${BUCKET:-intip-app-artifacts}"
REGION="${REGION:-garage}"

CREDS_FILE="${CREDS_FILE:-$HOME/.intip-s3.env}"
[ -f "$CREDS_FILE" ] && . "$CREDS_FILE"

export AWS_ACCESS_KEY_ID="GK6eb818d4448252284ac0b75d"
export AWS_SECRET_ACCESS_KEY="388db9e847b059446cfd46a6f0e10ce092cfc43135d5a446f73043bd386049c7"
export AWS_DEFAULT_REGION="$REGION"

# Garage는 AWS CLI v2가 기본으로 붙이는 CRC32 체크섬 헤더를 받아주지 않을 수
# 있다. 서명(SigV4)에 필요한 경우에만 계산하게 낮춰둔다.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

# ── 유틸 ────────────────────────────────────────────────────────────
PASS=0; FAIL=0
ok()   { printf '  ✅ %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  ❌ %s\n' "$*"; FAIL=$((FAIL+1)); }
step() { printf '\n── %s\n' "$*"; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# AWS CLI v2는 커스텀 엔드포인트에서도 vhost-style을 시도할 수 있어서,
# path-style을 config로 못박는다 (*.s3.inuappcenter.kr DNS가 없다).
AWS_CFG="$(mktemp)"
cat > "$AWS_CFG" <<EOF
[default]
region = $REGION
s3 =
    addressing_style = path
EOF
export AWS_CONFIG_FILE="$AWS_CFG"

TMPDIR_="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_" "$AWS_CFG"; }
trap cleanup EXIT

s3api() { aws --endpoint-url "$S3_ENDPOINT" s3api "$@"; }

# ── 0. 사전 점검 ────────────────────────────────────────────────────
step "사전 점검"
command -v aws >/dev/null || { echo "aws CLI가 없다: brew install awscli"; exit 1; }
case "$AWS_ACCESS_KEY_ID" in
  GK_PLACEHOLDER*|"") echo "크레덴셜이 placeholder다. $CREDS_FILE 를 만들거나 환경변수로 넘겨라."; exit 1;;
esac
ok "aws CLI $(aws --version 2>&1 | cut -d' ' -f1)"
ok "엔드포인트 $S3_ENDPOINT / 버킷 $BUCKET / region $REGION"

# ── 1. 업로드할 파일 준비 ───────────────────────────────────────────
SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC="$TMPDIR_/smoke-payload.bin"
  # Range 검증이 의미 있으려면 1KB보다는 커야 한다.
  dd if=/dev/urandom of="$SRC" bs=1024 count=2048 2>/dev/null
fi
[ -f "$SRC" ] || { echo "파일이 없다: $SRC"; exit 1; }

SRC_SHA="$(sha256 "$SRC")"
SRC_SIZE="$(wc -c < "$SRC" | tr -d ' ')"
KEY="smoke/$(date +%Y%m%d-%H%M%S)-$(basename "$SRC")"

step "대상"
echo "  파일   $SRC ($SRC_SIZE bytes)"
echo "  sha256 $SRC_SHA"
echo "  키     s3://$BUCKET/$KEY"

# ── 2. 버킷 접근 ────────────────────────────────────────────────────
step "1) 버킷 접근 (path-style, SigV4)"
if s3api list-objects-v2 --bucket "$BUCKET" --max-keys 1 >/dev/null 2>"$TMPDIR_/err"; then
  ok "ListObjectsV2 성공"
else
  bad "ListObjectsV2 실패: $(tr -d '\n' < "$TMPDIR_/err" | tail -c 300)"
  echo; echo "키 권한(garage bucket allow --read --write $BUCKET --key <키>)부터 확인해라."
  exit 1
fi

# ── 3. PUT ──────────────────────────────────────────────────────────
step "2) PUT"
CONTENT_TYPE="application/octet-stream"
case "$SRC" in
  *.ipa) CONTENT_TYPE="application/octet-stream" ;;
  *.apk) CONTENT_TYPE="application/vnd.android.package-archive" ;;
  *.plist) CONTENT_TYPE="application/xml" ;;
  *.html) CONTENT_TYPE="text/html; charset=utf-8" ;;
esac
if s3api put-object --bucket "$BUCKET" --key "$KEY" --body "$SRC" \
      --content-type "$CONTENT_TYPE" >/dev/null 2>"$TMPDIR_/err"; then
  ok "업로드 성공 (content-type: $CONTENT_TYPE)"
else
  bad "업로드 실패: $(tr -d '\n' < "$TMPDIR_/err" | tail -c 300)"; exit 1
fi

# ── 4. HEAD ─────────────────────────────────────────────────────────
step "3) HEAD"
if HEAD_JSON="$(s3api head-object --bucket "$BUCKET" --key "$KEY" 2>"$TMPDIR_/err")"; then
  REMOTE_SIZE="$(printf '%s' "$HEAD_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["ContentLength"])')"
  [ "$REMOTE_SIZE" = "$SRC_SIZE" ] && ok "크기 일치 ($REMOTE_SIZE bytes)" \
                                   || bad "크기 불일치: 로컬 $SRC_SIZE vs 원격 $REMOTE_SIZE"
else
  bad "HEAD 실패: $(tr -d '\n' < "$TMPDIR_/err" | tail -c 300)"
fi

# ── 5. GET (S3 API) ─────────────────────────────────────────────────
step "4) GET (S3 API)"
if s3api get-object --bucket "$BUCKET" --key "$KEY" "$TMPDIR_/dl-s3.bin" >/dev/null 2>"$TMPDIR_/err"; then
  DL_SHA="$(sha256 "$TMPDIR_/dl-s3.bin")"
  [ "$DL_SHA" = "$SRC_SHA" ] && ok "sha256 일치" || bad "sha256 불일치: $DL_SHA"
else
  bad "GET 실패: $(tr -d '\n' < "$TMPDIR_/err" | tail -c 300)"
fi

# ── 6. 공개 다운로드 (web endpoint) ─────────────────────────────────
PUBLIC_URL="$WEB_BASE/$BUCKET/$KEY"
step "5) 공개 다운로드  $PUBLIC_URL"
HTTP_CODE="$(curl -sS -o "$TMPDIR_/dl-web.bin" -w '%{http_code}' -m 120 "$PUBLIC_URL" || echo 000)"
if [ "$HTTP_CODE" = "200" ]; then
  WEB_SHA="$(sha256 "$TMPDIR_/dl-web.bin")"
  [ "$WEB_SHA" = "$SRC_SHA" ] && ok "200, sha256 일치" || bad "200이지만 sha256 불일치: $WEB_SHA"
else
  bad "HTTP $HTTP_CODE"
  case "$HTTP_CODE" in
    404) echo "     → 버킷 website 노출이 꺼져 있을 수 있다: garage bucket website --allow $BUCKET" ;;
    50*) echo "     → Caddy가 Garage에 못 붙는 상태. 컨테이너 바인딩/포트 매핑 확인." ;;
  esac
fi

# ── 7. Range 요청 ───────────────────────────────────────────────────
step "6) Range 요청 (iOS 무선 설치가 사용)"
RANGE_CODE="$(curl -sS -r 0-1023 -o "$TMPDIR_/range.bin" -w '%{http_code}' -m 60 "$PUBLIC_URL" || echo 000)"
RANGE_SIZE="$(wc -c < "$TMPDIR_/range.bin" 2>/dev/null | tr -d ' ' || echo 0)"
if [ "$RANGE_CODE" = "206" ] && [ "$RANGE_SIZE" = "1024" ]; then
  ok "206 Partial Content, 1024 bytes"
else
  bad "HTTP $RANGE_CODE, $RANGE_SIZE bytes (206/1024 기대) — CF나 Caddy가 Range를 죽이고 있다"
fi

# ── 8. 정리 ─────────────────────────────────────────────────────────
step "7) 정리"
if [ "${KEEP:-0}" = "1" ]; then
  ok "KEEP=1 — 객체 유지: $PUBLIC_URL"
else
  if s3api delete-object --bucket "$BUCKET" --key "$KEY" >/dev/null 2>"$TMPDIR_/err"; then
    ok "테스트 객체 삭제"
  else
    bad "삭제 실패: $(tr -d '\n' < "$TMPDIR_/err" | tail -c 300)"
  fi
fi

printf '\n── 결과: %d 통과, %d 실패\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
