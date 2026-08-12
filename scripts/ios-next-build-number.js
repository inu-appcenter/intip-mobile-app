#!/usr/bin/env node
/**
 * kr.inuappcenter.intip 앱에 App Store Connect로 이미 업로드된 빌드 중 가장 큰
 * CFBundleVersion(=buildNumber)을 조회해서, 그보다 1 큰 값을 표준출력(stdout)에
 * 정수로 찍는다.
 *
 * 배경: xcodebuild archive → altool 업로드 흐름에서 CURRENT_PROJECT_VERSION이
 * 이전에 올라간 값과 같으면 -19232/DUPLICATE로 거부된다 (app.json의
 * ios.buildNumber를 커밋마다 손으로 올려야 했던 이유). CI는 prebuild 직전에
 * 이 스크립트로 "다음 buildNumber"를 계산해 EXPO_IOS_BUILD_NUMBER 환경변수로
 * 넘기고, app.config.js가 app.json의 값 대신 그걸 써서 prebuild 결과물
 * (Info.plist / project.pbxproj)에 반영한다.
 *
 * 사용법:
 *   node scripts/ios-next-build-number.js --key <AuthKey_XXXXXXXXXX.p8 경로> \
 *     --key-id <id> --issuer <issuer-id>
 *
 *   # stdout엔 다음 buildNumber(정수)만 찍는다 — CI에서 $(...)로 캡처하는 용도.
 *   # 진행 로그는 전부 stderr로 간다.
 *
 * 옵션 (또는 환경변수) — ios-reissue-provisioning-profile.js와 같은 패턴:
 *   --key <path>            AuthKey_<id>.p8 경로   (APP_STORE_CONNECT_KEY_PATH)
 *   --key-id <id>           Key ID, 기본 45D3A26734 (APP_STORE_CONNECT_KEY_ID)
 *   --issuer <id>           Issuer ID               (APP_STORE_CONNECT_ISSUER_ID)
 *   --bundle-id <id>        기본 kr.inuappcenter.intip
 *
 * 의존성 없음 — 다른 ios-*.js 스크립트와 같은 패턴.
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

const API_ROOT = "https://api.appstoreconnect.apple.com/v1";
const DEFAULT_KEY_ID = "45D3A26734"; // .github/workflows/ci.yml과 동일 — 비밀 아님
const DEFAULT_BUNDLE_ID = "kr.inuappcenter.intip"; // app.json ios.bundleIdentifier

function usage(exitCode) {
  console.error(
    `사용법:\n` +
      `  node scripts/ios-next-build-number.js \\\n` +
      `    --key <AuthKey_XXXXXXXXXX.p8 경로> --key-id <id> --issuer <issuer-id>\n\n` +
      `stdout엔 다음 buildNumber(정수)만 출력한다. 옵션 (또는 환경변수):\n` +
      `  --key <path>       AuthKey_<id>.p8 경로 (APP_STORE_CONNECT_KEY_PATH)\n` +
      `  --key-id <id>      Key ID, 기본 ${DEFAULT_KEY_ID} (APP_STORE_CONNECT_KEY_ID)\n` +
      `  --issuer <id>      Issuer ID (APP_STORE_CONNECT_ISSUER_ID)\n` +
      `  --bundle-id <id>   기본 ${DEFAULT_BUNDLE_ID}\n`,
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { bundleId: DEFAULT_BUNDLE_ID };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--key") args.key = argv[++i];
    else if (a === "--key-id") args.keyId = argv[++i];
    else if (a === "--issuer") args.issuer = argv[++i];
    else if (a === "--bundle-id") args.bundleId = argv[++i];
    else if (a === "-h" || a === "--help") usage(0);
    else {
      console.error(`알 수 없는 인자: ${a}\n`);
      usage(1);
    }
  }
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
  const text = res.status === 204 ? null : await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // no-op — 에러 응답이 JSON이 아닐 수도 있음
  }
  if (!res.ok) {
    const detail = json?.errors?.map((e) => e.detail ?? e.title).join("; ") ?? text;
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${detail}`);
  }
  return json;
}

async function findAppResourceId(jwt, bundleId) {
  const data = await apiRequest(jwt, "GET", `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
  const appId = data.data?.[0]?.id;
  if (!appId) {
    throw new Error(
      `App을 찾지 못했습니다 (bundleId=${bundleId}) — App Store Connect에 앱이 먼저 생성돼 있어야 합니다.`,
    );
  }
  return appId;
}

/** 지금까지 업로드된 빌드 중 가장 큰 CFBundleVersion. 업로드된 빌드가 없으면 0. */
async function latestUploadedVersion(jwt, appId) {
  const data = await apiRequest(jwt, "GET", `/builds?filter[app]=${appId}&sort=-version&limit=1`);
  const version = data.data?.[0]?.attributes?.version;
  return version ? parseInt(version, 10) : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

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

  const appId = await findAppResourceId(jwt, args.bundleId);
  const latest = await latestUploadedVersion(jwt, appId);
  const next = latest + 1;

  console.error(`${args.bundleId}: 마지막으로 올라간 buildNumber=${latest || "(없음)"} → 다음 값=${next}`);
  console.log(next);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
