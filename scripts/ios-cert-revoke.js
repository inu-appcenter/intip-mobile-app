#!/usr/bin/env node
/**
 * App Store Connect API로 iOS 서명 인증서를 조회/해지한다.
 *
 * 배경: Archive를 `-allowProvisioningUpdates`(자동 서명)로 돌리면 CI가 매
 * 실행마다 쓰고 버리는 keychain 안에서 인증서를 새로 만드는데, 실행이
 * 끝나면 그 keychain과 함께 개인키도 지워진다. Apple 서버에는 인증서가
 * 개인키 없이 계속 등록된 채로 남아 결국 계정의 인증서 개수 한도를 채웠고
 * ("Choose a certificate to revoke") — CI#53이 그렇게 실패했다. (지금은
 * ios-release가 수동 서명으로 전환돼 더는 이 문제가 안 생기지만, 이미 쌓인
 * 인증서 정리와 앞으로 비슷한 일이 생겼을 때를 위해 이 스크립트는 남겨둔다.)
 *
 * Apple Developer 포털 웹 로그인 권한이 없는 계정이라, CI에도 등록돼 있는
 * App Store Connect API 키로 대신 조회/해지한다.
 * https://developer.apple.com/documentation/appstoreconnectapi/certificates
 *
 * 사용법:
 *   node scripts/ios-cert-revoke.js list [--type <CertificateType>]
 *   node scripts/ios-cert-revoke.js revoke <certificate-id>
 *
 * 공통 옵션 (또는 환경변수):
 *   --key <path>    AuthKey_<id>.p8 경로       (APP_STORE_CONNECT_KEY_PATH)
 *   --key-id <id>   Key ID, 기본 45D3A26734     (APP_STORE_CONNECT_KEY_ID)
 *   --issuer <id>   Issuer ID                   (APP_STORE_CONNECT_ISSUER_ID)
 *
 * CertificateType 예: IOS_DEVELOPMENT, IOS_DISTRIBUTION, DEVELOPMENT, DISTRIBUTION
 * (list 기본값은 IOS_DEVELOPMENT — CI#53에서 한도를 채운 타입)
 *
 * 의존성 없음 — node:crypto로 ES256 JWT를 직접 서명한다(send-test-push.js가
 * FCM에 RS256로 하는 것과 같은 패턴).
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

const API_ROOT = "https://api.appstoreconnect.apple.com/v1";
const DEFAULT_KEY_ID = "45D3A26734"; // .github/workflows/ci.yml과 동일 — 비밀 아님

function usage(exitCode) {
  console.log(
    `사용법:\n` +
      `  node scripts/ios-cert-revoke.js list [--type <CertificateType>]\n` +
      `  node scripts/ios-cert-revoke.js revoke <certificate-id>\n\n` +
      `옵션 (또는 환경변수):\n` +
      `  --key <path>    AuthKey_<id>.p8 경로 (APP_STORE_CONNECT_KEY_PATH)\n` +
      `  --key-id <id>   Key ID, 기본 ${DEFAULT_KEY_ID} (APP_STORE_CONNECT_KEY_ID)\n` +
      `  --issuer <id>   Issuer ID (APP_STORE_CONNECT_ISSUER_ID)\n\n` +
      `CertificateType 예: IOS_DEVELOPMENT, IOS_DISTRIBUTION, DEVELOPMENT, DISTRIBUTION\n` +
      `(list 기본값은 IOS_DEVELOPMENT)\n`,
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { type: "IOS_DEVELOPMENT" };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--key") args.key = argv[++i];
    else if (a === "--key-id") args.keyId = argv[++i];
    else if (a === "--issuer") args.issuer = argv[++i];
    else if (a === "--type") args.type = argv[++i];
    else if (a === "-h" || a === "--help") usage(0);
    else rest.push(a);
  }
  args.command = rest[0];
  args.certId = rest[1];
  return args;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/** App Store Connect API용 ES256 JWT (RFC 7519). exp는 최대 20분까지만 허용된다. */
function buildJwt({ keyId, issuerId, privateKey }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 60 * 15, aud: "appstoreconnect-v1" }),
  );
  const signingInput = `${header}.${payload}`;
  // JOSE(ES256)는 DER이 아니라 raw r||s 64바이트 서명을 요구한다 —
  // dsaEncoding: 'ieee-p1363'가 바로 그 포맷을 낸다.
  const signature = crypto
    .createSign("SHA256")
    .update(signingInput)
    .sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(signature)}`;
}

async function apiRequest(jwt, method, path) {
  const res = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command) usage(1);

  const keyId = args.keyId ?? process.env.APP_STORE_CONNECT_KEY_ID ?? DEFAULT_KEY_ID;
  const issuerId = args.issuer ?? process.env.APP_STORE_CONNECT_ISSUER_ID;
  const keyPath = args.key ?? process.env.APP_STORE_CONNECT_KEY_PATH;

  if (!issuerId) {
    console.error("Issuer ID가 없습니다. --issuer 또는 APP_STORE_CONNECT_ISSUER_ID를 지정하세요.");
    process.exit(1);
  }
  if (!keyPath) {
    console.error("개인키 경로가 없습니다. --key 또는 APP_STORE_CONNECT_KEY_PATH를 지정하세요.");
    process.exit(1);
  }
  const privateKey = fs.readFileSync(keyPath, "utf8");
  const jwt = buildJwt({ keyId, issuerId, privateKey });

  if (args.command === "list") {
    const data = await apiRequest(
      jwt,
      "GET",
      `/certificates?filter[certificateType]=${encodeURIComponent(args.type)}&limit=200`,
    );
    if (!data.data.length) {
      console.log(`(${args.type} 인증서 없음)`);
      return;
    }
    for (const c of data.data) {
      const a = c.attributes;
      console.log(`${c.id}\t${a.displayName}\tserial=${a.serialNumber}\texpires=${a.expirationDate}`);
    }
  } else if (args.command === "revoke") {
    if (!args.certId) {
      console.error("해지할 인증서 id가 필요합니다: node scripts/ios-cert-revoke.js revoke <id>\n");
      usage(1);
    }
    await apiRequest(jwt, "DELETE", `/certificates/${args.certId}`);
    console.log(`해지 완료: ${args.certId}`);
  } else {
    console.error(`알 수 없는 명령: ${args.command}\n`);
    usage(1);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
