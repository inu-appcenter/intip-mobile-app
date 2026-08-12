#!/usr/bin/env node
/**
 * kr.inuappcenter.intip App ID에 Associated Domains capability를 켜고,
 * 그 capability를 포함한 새 App Store 배포용 프로비저닝 프로파일을 발급받는다.
 *
 * 배경: 릴리스가 수동 서명(withIOSManualSigning.js)을 쓰기 때문에, App ID에
 * 새 capability를 추가해도 이미 발급돼 있던 프로파일에는 반영되지 않는다 —
 * 프로파일을 새로 만들어야 엔타이틀먼트가 일치해서 Archive가 통과한다.
 * ios-check-provisioning-access.js로 이 키가 필요한 쓰기 권한(Admin 롤)을
 * 갖고 있는 것을 먼저 확인했다.
 *
 * 이 스크립트가 하는 일 (idempotent):
 *   1. kr.inuappcenter.intip의 현재 capability 조회 — ASSOCIATED_DOMAINS가
 *      이미 있으면 2단계는 건너뜀
 *   2. 없으면 POST /bundleIdCapabilities로 추가
 *   3. Distribution 인증서를 --certificate-id로 지정하거나, 유효한 게
 *      하나뿐이면 자동으로 골라서 POST /profiles (profileType:
 *      IOS_APP_STORE)로 새 프로파일 발급
 *   4. 응답의 attributes.profileContent(이미 base64)를 파일로 저장 —
 *      이 파일 내용을 그대로 IOS_PROVISIONING_PROFILE_BASE64 시크릿 값으로
 *      쓰면 된다
 *
 * 이 스크립트는 실제 App ID를 변경한다 (더미 아님). 기존 프로파일은
 * 삭제하지 않으니, 새 시크릿 값으로 CI가 잘 도는 걸 확인한 뒤 Apple
 * Developer 포털에서 예전 프로파일을 정리해도 된다.
 *
 * 사용법 (PowerShell):
 *   node scripts/ios-reissue-provisioning-profile.js `
 *     --key C:\path\to\AuthKey_XXXXXXXXXX.p8 `
 *     --key-id XXXXXXXXXX `
 *     --issuer <issuer-id>
 *
 *   # 인증서가 여러 개 잡히면 먼저 목록만 보기:
 *   node scripts/ios-reissue-provisioning-profile.js --list-certificates ...(위와 동일 옵션)
 *
 * 옵션 (또는 환경변수):
 *   --key <path>            AuthKey_<id>.p8 경로   (APP_STORE_CONNECT_KEY_PATH)
 *   --key-id <id>           Key ID, 기본 45D3A26734 (APP_STORE_CONNECT_KEY_ID)
 *   --issuer <id>           Issuer ID               (APP_STORE_CONNECT_ISSUER_ID)
 *   --bundle-id <id>        기본 kr.inuappcenter.intip
 *   --certificate-id <id>   쓸 Distribution 인증서 리소스 id (안 주면 자동 탐지 시도)
 *   --profile-name <name>   기본 "INTIP App Store <YYYYMMDD-HHmm>"
 *   --out <path>            base64 저장 경로, 기본 ./INTIP.mobileprovision.base64
 *   --list-certificates     인증서 목록만 보고 종료 (발급/변경 없음)
 *   --dry-run               capability/프로파일 생성 없이 계획만 출력
 *
 * 의존성 없음 — ios-cert-revoke.js / ios-check-provisioning-access.js와 같은 패턴.
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

const API_ROOT = "https://api.appstoreconnect.apple.com/v1";
const DEFAULT_KEY_ID = "45D3A26734"; // .github/workflows/ci.yml과 동일 — 비밀 아님
const DEFAULT_BUNDLE_ID = "kr.inuappcenter.intip"; // app.json ios.bundleIdentifier

function usage(exitCode) {
  console.log(
    `사용법 (PowerShell):\n` +
      `  node scripts/ios-reissue-provisioning-profile.js \`\n` +
      `    --key <AuthKey_XXXXXXXXXX.p8 경로> --key-id <id> --issuer <issuer-id>\n\n` +
      `옵션 (또는 환경변수):\n` +
      `  --key <path>            AuthKey_<id>.p8 경로 (APP_STORE_CONNECT_KEY_PATH)\n` +
      `  --key-id <id>           Key ID, 기본 ${DEFAULT_KEY_ID} (APP_STORE_CONNECT_KEY_ID)\n` +
      `  --issuer <id>           Issuer ID (APP_STORE_CONNECT_ISSUER_ID)\n` +
      `  --bundle-id <id>        기본 ${DEFAULT_BUNDLE_ID}\n` +
      `  --certificate-id <id>   쓸 Distribution 인증서 리소스 id\n` +
      `  --profile-name <name>   기본 "INTIP App Store <타임스탬프>"\n` +
      `  --out <path>            base64 저장 경로, 기본 ./INTIP.mobileprovision.base64\n` +
      `  --list-certificates     인증서 목록만 보고 종료\n` +
      `  --dry-run               계획만 출력, 실제 변경 없음\n`,
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { bundleId: DEFAULT_BUNDLE_ID, out: "./INTIP.mobileprovision.base64" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--key") args.key = argv[++i];
    else if (a === "--key-id") args.keyId = argv[++i];
    else if (a === "--issuer") args.issuer = argv[++i];
    else if (a === "--bundle-id") args.bundleId = argv[++i];
    else if (a === "--certificate-id") args.certificateId = argv[++i];
    else if (a === "--profile-name") args.profileName = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--list-certificates") args.listCertificates = true;
    else if (a === "--dry-run") args.dryRun = true;
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

function timestampSuffix() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function findBundleIdResourceId(jwt, identifier) {
  const data = await apiRequest(
    jwt,
    "GET",
    `/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=1`,
  );
  const resourceId = data.data?.[0]?.id;
  if (!resourceId) {
    throw new Error(`Bundle ID를 찾지 못했습니다: ${identifier}`);
  }
  return resourceId;
}

async function listDistributionCertificates(jwt) {
  // 통합된 "DISTRIBUTION"(Apple Distribution)과 레거시 "IOS_DISTRIBUTION" 둘 다 조회.
  const data = await apiRequest(
    jwt,
    "GET",
    `/certificates?filter[certificateType]=DISTRIBUTION,IOS_DISTRIBUTION&limit=200`,
  );
  const now = new Date();
  return data.data.map((c) => ({
    id: c.id,
    name: c.attributes.displayName,
    serial: c.attributes.serialNumber,
    type: c.attributes.certificateType,
    expirationDate: c.attributes.expirationDate,
    expired: new Date(c.attributes.expirationDate) < now,
  }));
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

  if (args.listCertificates) {
    const certs = await listDistributionCertificates(jwt);
    if (!certs.length) {
      console.log("(Distribution 인증서 없음)");
      return;
    }
    for (const c of certs) {
      console.log(
        `${c.id}\t${c.name}\t${c.type}\tserial=${c.serial}\texpires=${c.expirationDate}` +
          (c.expired ? "  ⚠️ EXPIRED" : ""),
      );
    }
    return;
  }

  console.log(`대상 Bundle ID: ${args.bundleId}\n`);

  // ── 1. capability 확인/추가 ──────────────────────────────────────
  const bundleResourceId = await findBundleIdResourceId(jwt, args.bundleId);
  console.log(`Bundle ID 리소스: ${bundleResourceId}`);

  const caps = await apiRequest(jwt, "GET", `/bundleIds/${bundleResourceId}/bundleIdCapabilities`);
  const capTypes = caps.data.map((c) => c.attributes.capabilityType);
  console.log(`현재 capability: ${capTypes.length ? capTypes.join(", ") : "(없음)"}`);

  if (capTypes.includes("ASSOCIATED_DOMAINS")) {
    console.log("✅ ASSOCIATED_DOMAINS 이미 활성화되어 있음 — 추가 생략.\n");
  } else if (args.dryRun) {
    console.log("[dry-run] POST /bundleIdCapabilities (ASSOCIATED_DOMAINS)는 생략함.\n");
  } else {
    await apiRequest(jwt, "POST", "/bundleIdCapabilities", {
      data: {
        type: "bundleIdCapabilities",
        attributes: { capabilityType: "ASSOCIATED_DOMAINS", settings: [] },
        relationships: { bundleId: { data: { id: bundleResourceId, type: "bundleIds" } } },
      },
    });
    console.log("✅ ASSOCIATED_DOMAINS 활성화 완료.\n");
  }

  // ── 2. 인증서 결정 ────────────────────────────────────────────────
  let certificateId = args.certificateId;
  if (!certificateId) {
    const certs = (await listDistributionCertificates(jwt)).filter((c) => !c.expired);
    if (certs.length === 1) {
      certificateId = certs[0].id;
      console.log(`Distribution 인증서 자동 선택: ${certs[0].name} (${certificateId})\n`);
    } else if (certs.length === 0) {
      throw new Error("유효한 Distribution 인증서가 없습니다. Apple Developer 포털에서 확인하세요.");
    } else {
      console.log("유효한 Distribution 인증서가 여러 개입니다 — --certificate-id로 하나를 지정하세요:");
      for (const c of certs) {
        console.log(`  ${c.id}\t${c.name}\tserial=${c.serial}\texpires=${c.expirationDate}`);
      }
      process.exit(1);
    }
  }

  // ── 3. 프로파일 발급 ──────────────────────────────────────────────
  const profileName = args.profileName ?? `INTIP App Store ${timestampSuffix()}`;
  if (args.dryRun) {
    console.log(`[dry-run] POST /profiles 생략 — name="${profileName}", certificate=${certificateId}`);
    return;
  }

  const profile = await apiRequest(jwt, "POST", "/profiles", {
    data: {
      type: "profiles",
      attributes: { name: profileName, profileType: "IOS_APP_STORE" },
      relationships: {
        bundleId: { data: { id: bundleResourceId, type: "bundleIds" } },
        certificates: { data: [{ id: certificateId, type: "certificates" }] },
      },
    },
  });

  const content = profile.data?.attributes?.profileContent;
  if (!content) {
    throw new Error("응답에 profileContent가 없습니다 — 원본 응답을 확인하세요:\n" + JSON.stringify(profile));
  }
  fs.writeFileSync(args.out, content, "utf8");

  console.log(`✅ 새 프로파일 발급 완료: "${profileName}" (uuid ${profile.data.attributes.uuid})`);
  console.log(`   base64 저장: ${args.out}\n`);
  console.log("다음 단계:");
  console.log(`  1. ${args.out} 내용을 IOS_PROVISIONING_PROFILE_BASE64 GitHub 시크릿 값으로 교체`);
  console.log(`     (PowerShell) gh secret set IOS_PROVISIONING_PROFILE_BASE64 --body-file "${args.out}"`);
  console.log(`  2. app.json ios.entitlements에 com.apple.developer.associated-domains 도메인 목록 추가`);
  console.log(`  3. CI 재실행해서 Archive 확인 후, 예전 프로파일은 Apple Developer 포털에서 정리`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
