const fs = require("node:fs");
const crypto = require("node:crypto");

// ================= [ 설정 영역 ] =================
const FCM_TOKEN = "";
const PROJECT_ID = "intip-661f5"; // 예: my-app-12345
const SA_KEY_PATH = "./services_account.json"; // 서비스 계정 키 파일 경로
// =================================================

const base64url = (buf) => Buffer.from(buf).toString("base64url");

/** 서비스 계정으로 RS256 JWT를 서명해 액세스 토큰을 발급받습니다. */
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), sa.private_key).toString("base64url");

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`토큰 발급 실패: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function sendTestPush() {
  const sa = JSON.parse(fs.readFileSync(SA_KEY_PATH, "utf8"));
  const accessToken = await getAccessToken(sa);

  // 전송할 페이로드 (data 내부의 값은 반드시 문자열이어야 합니다)
  const message = {
    token: FCM_TOKEN,
    notification: {
      title: "[테스트] 새 채팅",
      body: "친구 카테고리 채팅 탭 라우팅 테스트",
    },
    data: {
      type: "CHAT",
      targetId: "2899", // member 식별자
      path: "/chat/list?category=친구", // 메인 탭 SPA 라우팅 유도
    },
  };

  console.log("🚀 푸시 알림 발송 중...");
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });

  const bodyText = await res.text();
  if (res.ok) {
    console.log("✅ 발송 성공:", JSON.parse(bodyText).name);
  } else {
    console.error(`❌ 발송 실패 (${res.status}):`, bodyText);
  }
}

sendTestPush().catch(console.error);