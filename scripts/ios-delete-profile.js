#!/usr/bin/env node
/**
 * App Store Connect의 프로비저닝 프로파일을 이름 또는 id로 삭제한다.
 *
 * 배경: ios-reissue-provisioning-profile.js가 짧은 시간 안에 여러 Bundle ID
 * (메인 앱 + Extension)에 대해 연달아 돌면, 기본 프로파일 이름이 분 단위
 * 타임스탬프(`INTIP App Store <YYYYMMDD-HHmm>`)라 같은 분 안이면 이름이
 * 겹친다. App Store Connect는 이름 중복인 채로 새 프로파일 생성을 막는다
 * (POST /profiles → 409 "Multiple profiles found with the name '...'").
 * 이 스크립트로 이름이 겹친 것들을 지우고 재발급하면 된다.
 *
 * 기본은 안전 모드: --name/--profile-id로 지정한 대상을 "조회해서 목록만
 * 보여주고" 끝난다. 실제로 지우려면 --yes를 반드시 같이 줘야 한다.
 *
 * 사용법 (PowerShell):
 *   # 이름으로 몇 개나 걸리는지 먼저 확인 (삭제 안 함)
 *   node scripts/ios-delete-profile.js `
 *     --key <AuthKey_XXXXXXXXXX.p8 경로> --key-id <id> --issuer <issuer-id> `
 *     --name "INTIP App Store 20260903-1836"
 *
 *   # 확인 후 실제 삭제
 *   node scripts/ios-delete-profile.js `
 *     --key <...> --key-id <id> --issuer <issuer-id> `
 *     --name "INTIP App Store 20260903-1836" --yes
 *
 *   # 특정 프로파일 하나만 id로 삭제
 *   node scripts/ios-delete-profile.js --key <...> --issuer <issuer-id> `
 *     --profile-id <profile-resource-id> --yes
 *
 * 옵션 (또는 환경변수):
 *   --key <path>          AuthKey_<id>.p8 경로   (APP_STORE_CONNECT_KEY_PATH)
 *   --key-id <id>         Key ID, 기본 45D3A26734 (APP_STORE_CONNECT_KEY_ID)
 *   --issuer <id>         Issuer ID               (APP_STORE_CONNECT_ISSUER_ID)
 *   --name <name>         이 이름과 정확히 일치하는 프로파일을 전부 대상으로
 *   --profile-id <id>     이 리소스 id 하나만 대상으로 (--name과 같이 못 씀)
 *   --keep-latest         --name과 같이 쓰면, 가장 최근 발급 1개는 남기고
 *                          나머지(중복분)만 지움
 *   --yes                 실제로 삭제 실행 (없으면 조회만 하고 끝)
 *
 * 의존성 없음 — 이 레포의 다른 ios-*.js 스크립트와 같은 패턴.
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

const API_ROOT = "https://api.appstoreconnect.apple.com/v1";
const DEFAULT_KEY_ID = "45D3A26734"; // .github/workflows/ci.yml과 동일 — 비밀 아님

function usage(exitCode) {
  console.log(
    `사용법 (PowerShell):\n` +
      `  node scripts/ios-delete-profile.js \`\n` +
      `    --key <AuthKey_XXXXXXXXXX.p8 경로> --key-id <id> --issuer <issuer-id> \`\n` +
      `    --name "INTIP App Store 20260903-1836" [--keep-latest] [--yes]\n\n` +
      `  node scripts/ios-delete-profile.js --key <...> --issuer <issuer-id> \`\n` +
      `    --profile-id <profile-resource-id> --yes\n\n` +
      `옵션 (또는 환경변수):\n` +
      `  --key <path>         AuthKey_<id>.p8 경로 (APP_STORE_CONNECT_KEY_PATH)\n` +
      `  --key-id <id>        Key ID, 기본 ${DEFAULT_KEY_ID} (APP_STORE_CONNECT_KEY_ID)\n` +
      `  --issuer <id>        Issuer ID (APP_STORE_CONNECT_ISSUER_ID)\n` +
      `  --name <name>        이 이름과 정확히 일치하는 프로파일 전부 대상\n` +
      `  --profile-id <id>    이 리소스 id 하나만 대상 (--name과 병용 불가)\n` +
      `  --keep-latest        --name 대상 중 가장 최근 1개는 남기고 나머지만 삭제\n` +
      `  --yes                실제로 삭제 (없으면 목록만 보여주고 끝)\n`,
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--key") args.key = argv[++i];
    else if (a === "--key-id") args.keyId = argv[++i];
    else if (a === "--issuer") args.issuer = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a === "--profile-id") args.profileId = argv[++i];
    else if (a === "--keep-latest") args.keepLatest = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "-h" || a === "--help") usage(0);
    else {
      console.error(`알 수 없는 인자: ${a}\n`);
      usage(1);
    }
  }
  if (!args.name && !args.profileId) {
    console.error("--name 또는 --profile-id 중 하나는 있어야 합니다.\n");
    usage(1);
  }
  if (args.name && args.profileId) {
    console.error("--name과 --profile-id는 같이 못 씁니다.\n");
    usage(1);
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

async function findProfilesByName(jwt, name) {
  const data = await apiRequest(
    jwt,
    "GET",
    `/profiles?filter[name]=${encodeURIComponent(name)}&limit=200&fields[profiles]=name,profileState,createdDate,uuid`,
  );
  return data.data.map((p) => ({
    id: p.id,
    name: p.attributes.name,
    state: p.attributes.profileState,
    uuid: p.attributes.uuid,
    createdDate: p.attributes.createdDate,
  }));
}

async function getProfileById(jwt, id) {
  const data = await apiRequest(jwt, "GET", `/profiles/${id}?fields[profiles]=name,profileState,createdDate,uuid`);
  const p = data.data;
  return { id: p.id, name: p.attributes.name, state: p.attributes.profileState, uuid: p.attributes.uuid, createdDate: p.attributes.createdDate };
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

  let targets;
  if (args.profileId) {
    targets = [await getProfileById(jwt, args.profileId)];
  } else {
    targets = await findProfilesByName(jwt, args.name);
    targets.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
    if (args.keepLatest && targets.length > 1) {
      const kept = targets[0];
      console.log(`--keep-latest: 가장 최근 것은 삭제 대상에서 제외 → "${kept.name}" (uuid ${kept.uuid}, 발급일 ${kept.createdDate})\n`);
      targets = targets.slice(1);
    }
  }

  if (!targets.length) {
    console.log("대상 프로파일이 없습니다. 이름/id를 확인하세요.");
    return;
  }

  console.log(`삭제 대상 프로파일 ${targets.length}개:`);
  for (const t of targets) {
    console.log(`  ${t.id}\t"${t.name}"\t${t.state}\tuuid=${t.uuid}\t발급일=${t.createdDate}`);
  }
  console.log();

  if (!args.yes) {
    console.log("[조회만 함] 실제로 삭제하려면 --yes를 붙여서 다시 실행하세요.");
    return;
  }

  for (const t of targets) {
    await apiRequest(jwt, "DELETE", `/profiles/${t.id}`);
    console.log(`✅ 삭제됨: ${t.id} ("${t.name}")`);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
