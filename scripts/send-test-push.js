#!/usr/bin/env node
/**
 * FCM 발송 시뮬레이터 — 서버의 `createMulticastMessage`(FcmMessageType 기반)와
 * 동일한 페이로드를 HTTP v1 API로 발송한다. 알림 탭 라우팅(G1~G7) 수동 QA용.
 *
 * FCM 콘솔은 임의 data 키를 실을 수 없으므로 반드시 이 스크립트(HTTP v1)로
 * 발송해야 한다 (docs/push-notification-routing/plan.md "수동 검증" 참조).
 *
 * 사용법:
 *   node scripts/send-test-push.js <scenario> --token <FCM_TOKEN> [--token ...]
 *     [--key <service-account.json>] [--project <id>] [--path <override>]
 *
 *   node scripts/send-test-push.js --list          # 시나리오 목록
 *
 * 서비스 계정 키: --key 또는 GOOGLE_APPLICATION_CREDENTIALS 환경변수.
 * (Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성)
 *
 * 의존성 없음 — node:crypto로 RS256 JWT를 직접 서명해 액세스 토큰을 얻는다.
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

// 서버 enum FcmMessageType과 동일한 이름을 쓴다.
// path 기대값은 docs/push-notification-routing/plan.md "서버가 보내는 것 (확정)" 표 기준.
// expect: 클라이언트 NavIntent 판정 기대 결과 (src/push/navIntent.ts)
const SCENARIOS = {
  general: {
    type: "GENERAL",
    targetId: 456,
    path: "/councilnoticedetail?id=456",
    title: "[테스트] 총학공지",
    body: "총학생회 공지 알림 — 비-메인탭이므로 sub-page push",
    expect: "push (쿼리스트링 id=456 보존 확인)",
  },
  chat: {
    type: "CHAT",
    targetId: 789,
    path: "/chat/789",
    extraData: { chatRoomId: "789" },
    title: "[테스트] 새 채팅",
    body: "채팅 알림 — 비-메인탭이므로 sub-page push",
    expect: "push (기존 스택 위에 얹힘, 뒤로가기로 복귀)",
  },
  friend: {
    type: "FRIEND",
    targetId: 1,
    path: "/friend/list",
    title: "[테스트] 친구 요청",
    body: "친구 알림 — 비-메인탭이므로 sub-page push",
    expect: "push",
  },
  "school-notice": {
    type: "SCHOOL_NOTICE",
    targetId: 123,
    path: "https://www.inu.ac.kr/bbs/inu/246/artclView.do",
    title: "[테스트] 학교 공지",
    body: "학교 공지 알림 — 외부 URL이므로 인앱 브라우저",
    expect: "external (인앱 브라우저, 닫으면 앱 복귀)",
  },
  department: {
    type: "DEPARTMENT",
    targetId: 124,
    path: "https://cse.inu.ac.kr/bbs/cse/1234/artclView.do",
    title: "[테스트] 학과 공지",
    body: "학과 공지 알림 — allowlist 서브도메인 확인",
    expect: "external (cse.inu.ac.kr 서브도메인 허용)",
  },
  // ↓ 라우팅 판정 경계 케이스 (서버가 실제로 보내는 조합은 아님)
  "main-tab": {
    type: "GENERAL",
    targetId: 0,
    path: "/chat/list",
    title: "[테스트] 메인탭 목적지",
    body: "메인탭 경로 — root SPA(goHome)로 collapse",
    expect: "spa (sub-page가 아니라 root SPA로 이동)",
  },
  "evil-host": {
    type: "SCHOOL_NOTICE",
    targetId: 999,
    path: "https://inu.ac.kr.evil.com/phish",
    title: "[테스트] 룩얼라이크 호스트",
    body: "allowlist 밖 — 탭해도 아무 일도 일어나지 않아야 함",
    expect: "null (무시 — 아무 동작 없음이 정답)",
  },
};

function usage(exitCode) {
  console.log(
    `사용법: node scripts/send-test-push.js <scenario> --token <FCM_TOKEN> [옵션]\n\n` +
      `시나리오:\n` +
      Object.entries(SCENARIOS)
        .map(([k, s]) => `  ${k.padEnd(14)} ${s.type.padEnd(14)} → ${s.expect}`)
        .join("\n") +
      `\n\n옵션:\n` +
      `  --token <t>     대상 기기 FCM 토큰 (반복 가능 = multicast 재현)\n` +
      `  --key <file>    서비스 계정 JSON (기본: $GOOGLE_APPLICATION_CREDENTIALS)\n` +
      `  --project <id>  Firebase 프로젝트 (기본: google-services.json에서 추출)\n` +
      `  --path <p>      시나리오의 path 오버라이드\n` +
      `  --dry-run       발송하지 않고 페이로드만 출력\n`,
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { tokens: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--token") args.tokens.push(argv[++i]);
    else if (a === "--key") args.key = argv[++i];
    else if (a === "--project") args.project = argv[++i];
    else if (a === "--path") args.path = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--list" || a === "-h" || a === "--help") usage(0);
    else rest.push(a);
  }
  args.scenario = rest[0];
  return args;
}

/**
 * 서버 createMulticastMessage와 동일한 규칙으로 v1 message 객체를 만든다.
 * - notification(title, body)과 data를 항상 함께 발송 (data-only 금지)
 * - targetId는 항상 문자열화, 공지 타입은 noticeId 중복 탑재
 * - 라우팅 정보는 data에만 (notification에 넣지 않음)
 * v1 API에는 multicast 엔드포인트가 없으므로 토큰별 :send 반복이
 * MulticastMessage.addAllTokens와 등가다.
 */
function buildMessage(token, scenario, pathOverride) {
  const data = {};
  if (scenario.type != null) data.type = scenario.type;
  if (scenario.targetId != null) {
    data.targetId = String(scenario.targetId);
    if (scenario.type === "SCHOOL_NOTICE" || scenario.type === "DEPARTMENT") {
      data.noticeId = String(scenario.targetId);
    }
  }
  const path = pathOverride ?? scenario.path;
  if (path && path.trim() !== "") data.path = path;
  Object.assign(data, scenario.extraData);

  return {
    token,
    notification: { title: scenario.title, body: scenario.body },
    data,
  };
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/** 서비스 계정으로 RS256 JWT를 서명해 OAuth2 액세스 토큰을 얻는다. */
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claims}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(unsigned), sa.private_key)
    .toString("base64url");

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) {
    throw new Error(`토큰 발급 실패 (${res.status}): ${await res.text()}`);
  }
  return (await res.json()).access_token;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.scenario) usage(1);
  const scenario = SCENARIOS[args.scenario];
  if (!scenario) {
    console.error(`알 수 없는 시나리오: ${args.scenario}\n`);
    usage(1);
  }
  if (args.tokens.length === 0 && !args.dryRun) {
    console.error("--token 이 최소 1개 필요합니다 (--dry-run 제외).\n");
    usage(1);
  }

  let project = args.project;
  if (!project) {
    const gs = JSON.parse(
      fs.readFileSync(`${__dirname}/../google-services.json`, "utf8"),
    );
    project = gs.project_info.project_id;
  }

  if (args.dryRun) {
    const msg = buildMessage(args.tokens[0] ?? "<TOKEN>", scenario, args.path);
    console.log(`project: ${project}\n기대 동작: ${scenario.expect}\n`);
    console.log(JSON.stringify({ message: msg }, null, 2));
    return;
  }

  const keyPath = args.key ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) {
    console.error(
      "서비스 계정 키가 없습니다. --key 또는 GOOGLE_APPLICATION_CREDENTIALS를 지정하세요.",
    );
    process.exit(1);
  }
  const sa = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  const accessToken = await getAccessToken(sa);

  console.log(`[${args.scenario}] 기대 동작: ${scenario.expect}`);
  let failed = 0;
  for (const token of args.tokens) {
    const message = buildMessage(token, scenario, args.path);
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${project}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
      },
    );
    const bodyText = await res.text();
    const short = `${token.slice(0, 12)}…`;
    if (res.ok) {
      console.log(`  ✓ ${short} → ${JSON.parse(bodyText).name}`);
    } else {
      failed++;
      console.error(`  ✗ ${short} (${res.status}): ${bodyText}`);
    }
  }
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
