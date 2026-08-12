#!/usr/bin/env node
/**
 * 지금 갖고 있는 App Store Connect API 키가 Associated Domains capability를
 * 켜고 프로비저닝 프로파일을 재발급할 권한이 있는지 검증한다.
 *
 * 배경: CI에 등록된 키(`APP_STORE_CONNECT_KEY_ID`, ci.yml:375)는 지금까지
 * altool 업로드에만 쓰였다(ci.yml:469 주석) — Certificates, Identifiers &
 * Profiles 쓰기 권한이 있는지는 실제로 검증된 적이 없다. Apple 문서 기준
 * API 키로 이 리소스를 다루려면 Admin 롤이어야 한다:
 * https://developer.apple.com/help/account/access/roles/
 *
 * 검증 방법: 실제 App ID(kr.inuappcenter.intip)는 절대 건드리지 않는다.
 * 대신
 *   1. 읽기 테스트 — 실제 bundle ID 조회 + 현재 capability 목록 확인
 *   2. 쓰기 테스트 — 임시 더미 Bundle ID를 하나 만들고, 그 위에 Associated
 *      Domains capability를 붙여본 뒤, 성공/실패와 무관하게 finally에서
 *      바로 삭제한다. 이게 실제로 하려는 작업(App ID에 capability 추가)과
 *      동일한 권한 경로를 타므로 가장 정확한 테스트다.
 *
 * 사용법:
 *   node scripts/ios-check-provisioning-access.js
 *   node scripts/ios-check-provisioning-access.js --read-only   # 쓰기 테스트(더미 생성) 생략
 *   node scripts/ios-check-provisioning-access.js --bundle-id kr.inuappcenter.intip
 *
 * 옵션 (또는 환경변수):
 *   --key <path>    AuthKey_<id>.p8 경로       (APP_STORE_CONNECT_KEY_PATH)
 *   --key-id <id>   Key ID, 기본 45D3A26734     (APP_STORE_CONNECT_KEY_ID)
 *   --issuer <id>   Issuer ID                   (APP_STORE_CONNECT_ISSUER_ID)
 *
 * 의존성 없음 — ios-cert-revoke.js와 같은 패턴.
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

const API_ROOT = "https://api.appstoreconnect.apple.com/v1";
const DEFAULT_KEY_ID = "45D3A26734"; // .github/workflows/ci.yml과 동일 — 비밀 아님
const DEFAULT_BUNDLE_ID = "kr.inuappcenter.intip"; // app.json ios.bundleIdentifier

function usage(exitCode) {
  console.log(
    `사용법:\n` +
      `  node scripts/ios-check-provisioning-access.js [--read-only] [--bundle-id <id>]\n\n` +
      `옵션 (또는 환경변수):\n` +
      `  --key <path>    AuthKey_<id>.p8 경로 (APP_STORE_CONNECT_KEY_PATH)\n` +
      `  --key-id <id>   Key ID, 기본 ${DEFAULT_KEY_ID} (APP_STORE_CONNECT_KEY_ID)\n` +
      `  --issuer <id>   Issuer ID (APP_STORE_CONNECT_ISSUER_ID)\n` +
      `  --read-only     더미 Bundle ID 생성/삭제(쓰기 테스트)를 생략하고 읽기만 확인\n`,
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { bundleId: DEFAULT_BUNDLE_ID, readOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--key") args.key = argv[++i];
    else if (a === "--key-id") args.keyId = argv[++i];
    else if (a === "--issuer") args.issuer = argv[++i];
    else if (a === "--bundle-id") args.bundleId = argv[++i];
    else if (a === "--read-only") args.readOnly = true;
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

/** ok=false일 때도 던지지 않고 {ok, status, body}를 그대로 돌려준다 — 403 자체가 유용한 결과라서. */
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
    // 에러 응답이 JSON이 아닐 수도 있다 — 그대로 text를 남긴다.
  }
  return { ok: res.ok, status: res.status, json, text };
}

function printStep(label, result) {
  if (result.ok) {
    console.log(`  ✅ ${label} (HTTP ${result.status})`);
  } else {
    const detail = result.json?.errors?.[0]?.detail ?? result.text ?? "";
    console.log(`  ❌ ${label} → HTTP ${result.status} ${detail}`);
  }
  return result.ok;
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

  console.log(`대상 Bundle ID: ${args.bundleId}\n`);

  // ── 1. 읽기 테스트 ────────────────────────────────────────────────
  console.log("[1/2] 읽기 권한 확인");
  const lookup = await apiRequest(
    jwt,
    "GET",
    `/bundleIds?filter[identifier]=${encodeURIComponent(args.bundleId)}&limit=1`,
  );
  const readOk = printStep(`GET /bundleIds?filter[identifier]=${args.bundleId}`, lookup);
  const realBundleResourceId = lookup.json?.data?.[0]?.id;

  if (readOk && realBundleResourceId) {
    const caps = await apiRequest(
      jwt,
      "GET",
      `/bundleIds/${realBundleResourceId}/bundleIdCapabilities`,
    );
    printStep(`GET /bundleIds/${realBundleResourceId}/bundleIdCapabilities`, caps);
    if (caps.ok) {
      const types = caps.json.data.map((c) => c.attributes.capabilityType);
      const hasAssocDomains = types.includes("ASSOCIATED_DOMAINS");
      console.log(
        `     현재 활성 capability: ${types.length ? types.join(", ") : "(없음)"}` +
          (hasAssocDomains ? "  ← ASSOCIATED_DOMAINS 이미 켜져 있음" : ""),
      );
    }
  } else if (readOk && !realBundleResourceId) {
    console.log(`     ⚠️  ${args.bundleId} 를 찾지 못했습니다 (오타 또는 다른 팀 계정?).`);
  }
  console.log();

  if (args.readOnly) {
    console.log("--read-only 지정됨: 쓰기 테스트(더미 Bundle ID 생성) 생략.");
    return;
  }
  if (!readOk) {
    console.log("읽기 자체가 막혀 있어 쓰기 테스트는 의미가 없습니다. 여기서 중단합니다.");
    process.exitCode = 1;
    return;
  }

  // ── 2. 쓰기 테스트 (실제 앱은 건드리지 않는 더미 Bundle ID) ─────────
  console.log("[2/2] 쓰기 권한 확인 (더미 Bundle ID로 capability 추가/삭제 — 실제 앱 무관)");
  const dummyIdentifier = `${args.bundleId}.permcheck${Date.now()}`;
  let dummyResourceId = null;
  let capabilityCreated = false;
  let writeVerdict = false;

  try {
    const createBundle = await apiRequest(jwt, "POST", "/bundleIds", {
      data: {
        type: "bundleIds",
        attributes: {
          identifier: dummyIdentifier,
          name: "intip-permcheck-DELETE-ME",
          platform: "IOS",
        },
      },
    });
    const createOk = printStep(`POST /bundleIds (${dummyIdentifier})`, createBundle);
    dummyResourceId = createBundle.json?.data?.id;

    if (createOk && dummyResourceId) {
      const addCapability = await apiRequest(jwt, "POST", "/bundleIdCapabilities", {
        data: {
          type: "bundleIdCapabilities",
          attributes: { capabilityType: "ASSOCIATED_DOMAINS", settings: [] },
          relationships: {
            bundleId: { data: { id: dummyResourceId, type: "bundleIds" } },
          },
        },
      });
      capabilityCreated = printStep("POST /bundleIdCapabilities (ASSOCIATED_DOMAINS)", addCapability);
      writeVerdict = capabilityCreated;
    }
  } finally {
    if (dummyResourceId) {
      const cleanup = await apiRequest(jwt, "DELETE", `/bundleIds/${dummyResourceId}`);
      printStep(`DELETE /bundleIds/${dummyResourceId} (정리)`, cleanup);
      if (!cleanup.ok) {
        console.log(
          `     ⚠️  더미 Bundle ID(${dummyIdentifier})가 정리되지 않았습니다 — ` +
            `Apple Developer 포털에서 수동으로 삭제해 주세요.`,
        );
      }
    }
  }

  console.log();
  console.log("── 결론 ──");
  if (writeVerdict) {
    console.log(
      `✅ 이 키로 ${args.bundleId}에 Associated Domains capability를 켜고 프로파일을 재발급할 수 있습니다.`,
    );
  } else {
    console.log(
      "❌ 이 키는 Certificates, Identifiers & Profiles 쓰기 권한이 없습니다.\n" +
        "   App Store Connect → Users and Access → Integrations에서 이 키(또는 새 키)의 롤을\n" +
        "   Admin으로 올려달라고 계정 관리자에게 요청해야 합니다.",
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
