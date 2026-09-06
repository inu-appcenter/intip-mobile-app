#!/usr/bin/env bash
#
# Garage(s3.inuappcenter.kr)에 파일 하나를 올린다.
#
#   ./scripts/garage-put.sh <로컬파일> <버킷내_키> [content-type]
#
# 크레덴셜은 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY 환경변수로 준다
# (CI는 GARAGE_S3_* 시크릿을 그 이름으로 매핑해서 넘긴다).
#
# aws CLI를 직접 쓰지 않고 이 래퍼를 두는 이유는 두 가지 우회 때문이다 —
# 둘 다 빼먹으면 조용히 실패한다. scripts/s3-smoke-test.sh와 동일하다.
set -euo pipefail

# 로컬 실행 편의: 크레덴셜을 ~/.intip-s3.env 에 둬도 된다
# (scripts/s3-smoke-test.sh와 동일한 규칙). CI는 환경변수로 넘긴다.
CREDS_FILE="${CREDS_FILE:-$HOME/.intip-s3.env}"
[ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ -f "$CREDS_FILE" ] && . "$CREDS_FILE"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

S3_ENDPOINT="${S3_ENDPOINT:-https://s3.inuappcenter.kr}"
BUCKET="${BUCKET:-intip-app-artifacts}"
REGION="${REGION:-garage}"

SRC="${1:?사용법: garage-put.sh <로컬파일> <키> [content-type]}"
KEY="${2:?사용법: garage-put.sh <로컬파일> <키> [content-type]}"
CTYPE="${3:-}"

[ -f "$SRC" ] || { echo "파일이 없다: $SRC" >&2; exit 1; }

if [ -z "$CTYPE" ]; then
  case "$SRC" in
    *.ipa)   CTYPE="application/octet-stream" ;;
    *.apk)   CTYPE="application/vnd.android.package-archive" ;;
    *.plist) CTYPE="application/xml" ;;
    *.html)  CTYPE="text/html; charset=utf-8" ;;
    *.png)   CTYPE="image/png" ;;
    *.json)  CTYPE="application/json" ;;
    *)       CTYPE="application/octet-stream" ;;
  esac
fi

# Garage는 AWS CLI v2가 기본으로 붙이는 CRC32 체크섬 헤더를 거부할 수 있다.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
export AWS_DEFAULT_REGION="$REGION"

# *.s3.inuappcenter.kr 와일드카드 DNS가 없어서 vhost-style은 못 쓴다.
AWS_CFG="$(mktemp)"
trap 'rm -f "$AWS_CFG"' EXIT
cat > "$AWS_CFG" <<EOF
[default]
region = $REGION
s3 =
    addressing_style = path
EOF
export AWS_CONFIG_FILE="$AWS_CFG"

aws --endpoint-url "$S3_ENDPOINT" s3api put-object \
  --bucket "$BUCKET" --key "$KEY" --body "$SRC" \
  --content-type "$CTYPE" >/dev/null

echo "⬆️  s3://$BUCKET/$KEY  ($(wc -c < "$SRC" | tr -d ' ') bytes, $CTYPE)"
