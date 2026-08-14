#!/usr/bin/env node
/**
 * expo-share-intent의 iOS Share Extension 타깃에 필요한 Apple 계정 쪽 설정 중,
 * App Store Connect API로 되는 부분만 처리한다.
 *
 * 배경: expo-share-intent iOS 지원은
 *   - 새 Bundle ID `<app>.share-extension` (Share Extension 타깃용)
 *   - 두 Bundle ID(메인 앱 + Extension) 모두에 App Groups capability
 *   - 실제 App Group(`group.<app>`) 생성 + 두 Bundle ID에 할당
 * 을 요구한다 (node_modules/expo-share-intent/plugin/build/ios/constants.js
 * 의 getAppGroup/getShareExtensionBundledIdentifier 기본값 기준).
 *
 * App Group "생성/할당"은 App Store Connect API에 없다 — Apple 개발자 포럼
 * 확인 결과 capability 자체는 켤 수 있어도 실제 group을 만들고 Bundle ID에
 * 붙이는 건 developer.apple.com UI에서만 가능하다:
 * https://developer.apple.com/forums/thread/778629
 *
 * 그래서 이 스크립트는 여기까지만 한다 (idempotent, 계정 UI 접근 불필요):
 *   1. Extension Bundle ID가 없으면 등록
 *   2. 메인 앱 + Extension 두 Bundle ID 모두에 APP_GROUPS capability 활성화
 * App Group 생성/할당과 그 이후 프로파일 재발급(ios-reissue-provisioning-
 * profile.js)은 별도로, App Group이 만들어진 뒤에 진행한다.
 *
 * 사용법 (PowerShell):
 *   node scripts/ios-setup-share-extension-bundle.js `
 *     --key <AuthKey_XXXXXXXXXX.p8 경로> --key-id <id> --issuer <issuer-id>
 *
 * 옵션 (또는 환경변수):
 *   --key <path>              AuthKey_<id>.p8 경로   (APP_STORE_CONNECT_KEY_PATH)
 *   --key-id <id>             Key ID, 기본 45D3A26734 (APP_STORE_CONNECT_KEY_ID)
 *   --issuer <id>             Issuer ID               (APP_STORE_CONNECT_ISSUER_ID)
 *   --bundle-id <id>          메인 앱, 기본 kr.inuappcenter.intip
 *   --extension-bundle-id <id> 기본 <bundle-id>.share-extension
 *   --dry-run                 계획만 출력, 실제 변경 없음
 *
 * 의존성 없음 — 이 레포의 다른 ios-*.js 스크립트와 같은 패턴.
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

const API_ROOT = "https://api.appstoreconnect.apple.com/v1";
const DEFAULT_KEY_ID = "45D3A26734"; // .github/workflows/ci.yml과 동일 — 비밀 아님
const DEFAULT_BUNDLE_ID = "kr.inuappcenter.intip"; // app.json ios.bundleIdentifier

function usage(exitCode) {
  console.log(
    `사용법 (PowerShell):\n` +
      `  node scripts/ios-setup-share-extension-bundle.js \`\n` +
      `    --key <AuthKey_XXXXXXXXXX.p8 경로> --key-id <id> --issuer <issuer-id>\n\n` +
      `옵션 (또는 환경변수):\n` +
      `  --key <path>               AuthKey_<id>.p8 경로 (APP_STORE_CONNECT_KEY_PATH)\n` +
      `  --key-id <id>              Key ID, 기본 ${DEFAULT_KEY_ID} (APP_STORE_CONNECT_KEY_ID)\n` +
      `  --issuer <id>              Issuer ID (APP_STORE_CONNECT_ISSUER_ID)\n` +
      `  --bundle-id <id>           메인 앱, 기본 ${DEFAULT_BUNDLE_ID}\n` +
      `  --extension-bundle-id <id> 기본 <bundle-id>.share-extension\n` +
      `  --dry-run                  계획만 출력, 실제 변경 없음\n`,
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
    else if (a === "--dry-run") args.dryRun = true;
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

async function apiRequest(jwt, method, path, body) {
  const res = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
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
  const data = await apiRequest(
    jwt,
    "GET",
    `/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=1`,
  );
  return data.data?.[0]?.id ?? null;
}

async function ensureAppGroupsCapability(jwt, { label, resourceId, dryRun }) {
  const caps = await apiRequest(jwt, "GET", `/bundleIds/${resourceId}/bundleIdCapabilities`);
  const types = caps.data.map((c) => c.attributes.capabilityType);
  console.log(`  [${label}] 현재 capability: ${types.length ? types.join(", ") : "(없음)"}`);
  if (types.includes("APP_GROUPS")) {
    console.log(`  [${label}] ✅ APP_GROUPS 이미 활성화되어 있음 — 생략.`);
    return;
  }
  if (dryRun) {
    console.log(`  [${label}] [dry-run] POST /bundleIdCapabilities (APP_GROUPS)는 생략함.`);
    return;
  }
  await apiRequest(jwt, "POST", "/bundleIdCapabilities", {
    data: {
      type: "bundleIdCapabilities",
      attributes: { capabilityType: "APP_GROUPS", settings: [] },
      relationships: { bundleId: { data: { id: resourceId, type: "bundleIds" } } },
    },
  });
  console.log(`  [${label}] ✅ APP_GROUPS 활성화 완료.`);
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

  // ── 1. 메인 앱 Bundle ID 리소스 조회 ─────────────────────────────
  const mainResourceId = await findBundleId(jwt, args.bundleId);
  if (!mainResourceId) {
    throw new Error(`메인 앱 Bundle ID를 찾지 못했습니다: ${args.bundleId}`);
  }
  console.log(`[1/3] 메인 앱 Bundle ID 리소스: ${mainResourceId}`);

  // ── 2. Extension Bundle ID 등록 (없으면) ────────────────────────
  console.log(`[2/3] Extension Bundle ID 확인`);
  let extResourceId = await findBundleId(jwt, args.extensionBundleId);
  if (extResourceId) {
    console.log(`  ✅ 이미 등록되어 있음: ${extResourceId} — 생략.`);
  } else if (args.dryRun) {
    console.log(`  [dry-run] POST /bundleIds (${args.extensionBundleId})는 생략함.`);
  } else {
    const created = await apiRequest(jwt, "POST", "/bundleIds", {
      data: {
        type: "bundleIds",
        attributes: {
          identifier: args.extensionBundleId,
          name: "INTIP Share Extension",
          platform: "IOS",
        },
      },
    });
    extResourceId = created.data.id;
    console.log(`  ✅ 등록 완료: ${extResourceId}`);
  }
  console.log();

  // ── 3. 양쪽에 APP_GROUPS capability ─────────────────────────────
  console.log(`[3/3] APP_GROUPS capability`);
  await ensureAppGroupsCapability(jwt, { label: "메인 앱", resourceId: mainResourceId, dryRun: args.dryRun });
  if (extResourceId) {
    await ensureAppGroupsCapability(jwt, {
      label: "Extension",
      resourceId: extResourceId,
      dryRun: args.dryRun,
    });
  } else {
    console.log(`  [Extension] Bundle ID가 아직 없어 생략 (dry-run).`);
  }

  console.log();
  console.log("── 남은 작업 (계정 UI 필요, API 불가) ──");
  console.log("  1. developer.apple.com → Identifiers → App Groups → + 로");
  console.log(`     group.${args.bundleId} 등록 (또는 원하는 group id)`);
  console.log("  2. Identifiers에서 메인 앱과 Extension 두 Bundle ID를 각각 열어");
  console.log("     App Groups capability에 방금 만든 그룹 체크");
  console.log("  3. 그 다음 두 Bundle ID 각각에 대해 scripts/ios-reissue-provisioning-profile.js 로 프로파일 재발급");
  console.log(`     (파일명이 겹치지 않게 --out 지정 필수):`);
  console.log(`     --bundle-id ${args.bundleId} --out ./INTIP.mobileprovision.base64`);
  console.log(`     --bundle-id ${args.extensionBundleId} --out ./INTIP-ShareExtension.mobileprovision.base64`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
