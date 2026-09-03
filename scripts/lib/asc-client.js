/**
 * App Store Connect API 공통 클라이언트 — ES256 JWT 서명 + fetch 래퍼 +
 * 자격증명 자동 탐색. 이 레포의 모든 ios-*.js 스크립트가 공유한다.
 *
 * 자격증명 우선순위 (각 항목 독립적으로 판단):
 *   1. CLI 플래그 (--key / --key-id / --issuer)
 *   2. 환경변수 (APP_STORE_CONNECT_KEY_PATH / _KEY_ID / _ISSUER_ID) — CI(ci.yml)와 동일
 *   3. ios_credentials/ 디렉터리 (로컬 전용, .gitignore로 커밋 안 됨):
 *      - key.env 안의 KEY_ID / ISSUER_ID
 *      - AuthKey_<keyId>.p8 (없으면 디렉터리 안의 AuthKey_*.p8 아무거나 하나)
 *
 * 즉 로컬에서는 아무 플래그 없이 ios_credentials/만 있으면 바로 되고, CI나
 * 다른 키를 쓸 때는 플래그/환경변수로 그대로 덮어쓸 수 있다.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const API_ROOT = "https://api.appstoreconnect.apple.com/v1";
const DEFAULT_KEY_ID = "45D3A26734"; // .github/workflows/ci.yml과 동일 — 비밀 아님
const CREDENTIALS_DIR = path.join(__dirname, "..", "..", "ios_credentials");

/** `KEY=VALUE` 줄만 있는 단순 .env 파서. 마지막 줄에 개행이 없어도 동작. */
function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function findAuthKeyFile(keyId) {
  if (!fs.existsSync(CREDENTIALS_DIR)) return null;
  const preferred = path.join(CREDENTIALS_DIR, `AuthKey_${keyId}.p8`);
  if (fs.existsSync(preferred)) return preferred;
  const any = fs.readdirSync(CREDENTIALS_DIR).find((f) => /^AuthKey_.*\.p8$/.test(f));
  return any ? path.join(CREDENTIALS_DIR, any) : null;
}

/**
 * args: { key, keyId, issuer } — 보통 parseArgs()가 만든 CLI 플래그 값.
 * 없는 값들은 환경변수 → ios_credentials/ 순으로 채운다.
 */
function resolveCredentials(args = {}) {
  const envCreds = parseEnvFile(path.join(CREDENTIALS_DIR, "key.env"));

  const keyId = args.keyId ?? process.env.APP_STORE_CONNECT_KEY_ID ?? envCreds.KEY_ID ?? DEFAULT_KEY_ID;
  const issuerId = args.issuer ?? process.env.APP_STORE_CONNECT_ISSUER_ID ?? envCreds.ISSUER_ID;
  const keyPath = args.key ?? process.env.APP_STORE_CONNECT_KEY_PATH ?? findAuthKeyFile(keyId);

  if (!issuerId) {
    throw new Error(
      "Issuer ID를 못 찾았습니다. --issuer / APP_STORE_CONNECT_ISSUER_ID 중 하나를 주거나 " +
        "ios_credentials/key.env에 ISSUER_ID=... 를 넣으세요.",
    );
  }
  if (!keyPath) {
    throw new Error(
      "개인키(.p8) 경로를 못 찾았습니다. --key / APP_STORE_CONNECT_KEY_PATH 중 하나를 주거나 " +
        `ios_credentials/AuthKey_${keyId}.p8 를 두세요.`,
    );
  }
  if (!fs.existsSync(keyPath)) {
    throw new Error(`개인키 파일이 없습니다: ${keyPath}`);
  }

  return { keyId, issuerId, keyPath, privateKey: fs.readFileSync(keyPath, "utf8") };
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

/** 자격증명을 찾아 JWT까지 발급한 클라이언트. request()로 API를 호출한다. */
function createClient(args = {}) {
  const creds = resolveCredentials(args);
  const jwt = buildJwt(creds);

  async function request(method, apiPath, body) {
    const res = await fetch(`${API_ROOT}${apiPath}`, {
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
      throw new Error(`${method} ${apiPath} → HTTP ${res.status}: ${detail}`);
    }
    return json;
  }

  return { jwt, request, keyId: creds.keyId, issuerId: creds.issuerId };
}

async function findBundleId(client, identifier) {
  const data = await client.request(
    "GET",
    `/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=1`,
  );
  return data.data?.[0]?.id ?? null;
}

/** CLI 어디서나 쓰는 공통 --key/--key-id/--issuer 플래그를 소비한다. 매칭 안 되면 false. */
function consumeCommonFlag(args, argv, i) {
  const a = argv[i];
  if (a === "--key") args.key = argv[++i];
  else if (a === "--key-id") args.keyId = argv[++i];
  else if (a === "--issuer") args.issuer = argv[++i];
  else return false;
  return true;
}

module.exports = {
  DEFAULT_KEY_ID,
  CREDENTIALS_DIR,
  resolveCredentials,
  buildJwt,
  createClient,
  findBundleId,
  consumeCommonFlag,
};
