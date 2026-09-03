#!/usr/bin/env node
/**
 * App Group(`group.<app>`)이 실제로 메인 앱 + Share Extension 두 Bundle ID에
 * 붙어 있는지 확인한다. 읽기 전용 (아무것도 만들거나 바꾸지 않음).
 *
 * 배경: App Store Connect API에는 App Group을 조회/생성하는 리소스가 없다
 * (ios-setup-share-extension-bundle.js 13–16행 주석, Apple 개발자 포럼
 * https://developer.apple.com/forums/thread/778629 참고 — `/appGroups`
 * 엔드포인트 자체가 존재하지 않음, 404 "path does not match a defined
 * resource type"로 확인됨). 대신 각 Bundle ID에 대해 이미 발급된 프로비저닝
 * 프로파일의 엔타이틀먼트를 까보면, 발급 시점에 그 Bundle ID에 붙어있던
 * App Group이 `com.apple.security.application-groups` 배열로 그대로 들어있다.
 * .mobileprovision은 서명(CMS)만 돼 있고 암호화는 안 돼 있어서, 안의 plist
 * XML을 raw 바이트에서 문자열로 그냥 찾아낼 수 있다 (macOS `security cms -D`와
 * 같은 목적, 의존성 없이).
 *
 * 주의: 프로파일은 "발급 시점 스냅샷"이다. developer.apple.com에서 방금
 * App Group을 붙였다면, 그 전에 발급된 프로파일에는 안 보이는 게 정상 —
 * ios-reissue-provisioning-profile.js로 새로 발급한 뒤 이 스크립트로 그
 * 새 프로파일을 다시 확인해야 한다.
 *
 * 사용법 (PowerShell):
 *   node scripts/ios-check-app-group.js `
 *     --key C:\path\to\AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer <issuer-id>
 *
 * 옵션 (또는 환경변수):
 *   --key <path>               AuthKey_<id>.p8 경로   (APP_STORE_CONNECT_KEY_PATH)
 *   --key-id <id>              Key ID, 기본 45D3A26734 (APP_STORE_CONNECT_KEY_ID)
 *   --issuer <id>              Issuer ID               (APP_STORE_CONNECT_ISSUER_ID)
 *   --bundle-id <id>           메인 앱, 기본 kr.inuappcenter.intip
 *   --extension-bundle-id <id> 기본 <bundle-id>.share-extension
 *
 * 의존성 없음 — 이 레포의 다른 ios-*.js 스크립트와 같은 패턴.
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

const API_ROOT = "https://api.appstoreconnect.apple.com/v1";
const DEFAULT_KEY_ID = "45D3A26734"; // .github/workflows/ci.yml과 동일 — 비밀 아님
const DEFAULT_BUNDLE_ID = "kr.inuappcenter.intip";

function usage(exitCode) {
  console.log(
    `사용법 (PowerShell):\n` +
      `  node scripts/ios-check-app-group.js \`\n` +
      `    --key <AuthKey_XXXXXXXXXX.p8 경로> --key-id <id> --issuer <issuer-id>\n\n` +
      `옵션 (또는 환경변수):\n` +
      `  --key <path>               AuthKey_<id>.p8 경로 (APP_STORE_CONNECT_KEY_PATH)\n` +
      `  --key-id <id>              Key ID, 기본 ${DEFAULT_KEY_ID} (APP_STORE_CONNECT_KEY_ID)\n` +
      `  --issuer <id>              Issuer ID (APP_STORE_CONNECT_ISSUER_ID)\n` +
      `  --bundle-id <id>           메인 앱, 기본 ${DEFAULT_BUNDLE_ID}\n` +
      `  --extension-bundle-id <id> 기본 <bundle-id>.share-extension\n`,
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
    else if (a === "--extension-bundle-id") args.extensionBundleId = argv[++i];
    else if (a === "-h" || a === "--help") usage(0);
    else {
      console.error(`알 수 없는 인자: ${a}\n`);
      usage(1);
    }
  }
  args.extensionBundleId = args.extensionBundleId ?? `${args.bundleId}.share-extension`;
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

async function findBundleId(jwt, identifier) {
  const data = await apiRequest(jwt, "GET", `/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=1`);
  return data.data?.[0]?.id ?? null;
}

/** 해당 Bundle ID에 대해 가장 최근 발급된 프로파일 하나(전체 내용 포함)를 가져온다. */
async function latestProfileFor(jwt, bundleResourceId) {
  const list = await apiRequest(
    jwt,
    "GET",
    `/bundleIds/${bundleResourceId}/profiles?limit=50&fields[profiles]=name,profileState,createdDate,uuid`,
  );
  if (!list.data.length) return null;
  const sorted = [...list.data].sort(
    (a, b) => new Date(b.attributes.createdDate) - new Date(a.attributes.createdDate),
  );
  const latest = sorted[0];
  const full = await apiRequest(
    jwt,
    "GET",
    `/profiles/${latest.id}?fields[profiles]=name,profileState,createdDate,uuid,profileContent`,
  );
  return full.data;
}

/**
 * .mobileprovision은 CMS(PKCS#7) 서명만 돼 있고 암호화는 안 돼 있어서, 안에
 * 든 plist XML이 raw 바이트에 그대로(사람이 읽을 수 있게) 들어있다. 전체
 * ASN.1/plist 파서 없이 문자열 검색만으로 Entitlements의
 * com.apple.security.application-groups 배열 값을 뽑아낸다.
 */
function extractAppGroups(profileContentBase64) {
  const raw = Buffer.from(profileContentBase64, "base64").toString("latin1");
  const keyIdx = raw.indexOf("com.apple.security.application-groups");
  if (keyIdx === -1) return [];
  const arrayStart = raw.indexOf("<array>", keyIdx);
  const arrayEnd = raw.indexOf("</array>", arrayStart);
  if (arrayStart === -1 || arrayEnd === -1) return [];
  const arrayBlock = raw.slice(arrayStart, arrayEnd);
  const groups = [];
  const re = /<string>([^<]*)<\/string>/g;
  let m;
  while ((m = re.exec(arrayBlock))) groups.push(m[1]);
  return groups;
}

async function reportFor(jwt, label, bundleId) {
  console.log(`── [${label}] ${bundleId} ──`);
  const resourceId = await findBundleId(jwt, bundleId);
  if (!resourceId) {
    console.log(`  ❌ Bundle ID가 계정에 없음\n`);
    return { groups: [] };
  }
  const profile = await latestProfileFor(jwt, resourceId);
  if (!profile) {
    console.log(`  ⚠️ 발급된 프로파일이 없음 — ios-reissue-provisioning-profile.js로 먼저 발급하세요.\n`);
    return { groups: [] };
  }
  const { name, createdDate, profileState, uuid } = profile.attributes;
  console.log(`  최근 프로파일: "${name}" (uuid ${uuid}, ${profileState}, 발급일 ${createdDate})`);
  const groups = extractAppGroups(profile.attributes.profileContent);
  if (groups.length) {
    console.log(`  ✅ App Group: ${groups.join(", ")}`);
  } else {
    console.log(`  ❌ 이 프로파일 엔타이틀먼트에 App Group 없음`);
    console.log(`     (발급 시점 이후에 App Group을 붙였다면 재발급 필요)`);
  }
  console.log();
  return { groups };
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

  console.log(`메인 앱 Bundle ID:      ${args.bundleId}`);
  console.log(`Extension Bundle ID:    ${args.extensionBundleId}\n`);

  const main_ = await reportFor(jwt, "메인 앱", args.bundleId);
  const ext = await reportFor(jwt, "Extension", args.extensionBundleId);

  console.log("── 결론 ──");
  const shared = main_.groups.filter((g) => ext.groups.includes(g));
  if (shared.length > 0) {
    console.log(`✅ 양쪽 최신 프로파일에 공통 App Group 확인됨: ${shared.join(", ")}`);
    console.log("   위젯/Share Extension 데이터 공유 전제 조건 충족. app.json 엔타이틀먼트에");
    console.log("   com.apple.security.application-groups로 반영하고 expo-widgets plugin을 켜면 됨.");
  } else {
    console.log("❌ 아직 양쪽 프로파일에 공통 App Group이 없음.");
    console.log("   developer.apple.com에서 App Group을 두 Bundle ID에 붙인 게 맞는지, 그리고 그");
    console.log("   *이후에* 프로파일을 재발급했는지 확인하세요 (ios-reissue-provisioning-profile.js).");
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
