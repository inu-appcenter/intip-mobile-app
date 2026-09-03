#!/usr/bin/env node
/**
 * App Store Connect API로 인증서 / 프로비저닝 프로파일 / Bundle ID capability /
 * App Group을 조회·관리하는 통합 CLI.
 *
 * 개별 ios-*.js 스크립트(ios-cert-revoke.js, ios-reissue-provisioning-profile.js,
 * ios-delete-profile.js, ios-check-app-group.js, ios-setup-share-extension-bundle.js,
 * ios-check-provisioning-access.js)는 그대로 남아있지만, 이 스크립트가 그 기능을
 * 서브커맨드로 한데 묶고 scripts/lib/asc-client.js를 통해 자격증명을
 * `ios_credentials/`에서 자동으로 찾는다 — --key/--issuer를 매번 안 줘도 됨.
 *
 * 사용법:
 *   node scripts/ios-asc.js <command> [subcommand] [options]
 *
 * 명령어:
 *   cert list [--type <CertificateType>]
 *   cert revoke <certificate-id>
 *
 *   profile list [--bundle-id <id>]
 *   profile reissue --bundle-id <id> [--certificate-id <id>] [--profile-name <name>]
 *                    [--out <path>] [--dry-run]
 *   profile delete (--name <name> | --profile-id <id>) [--keep-latest] [--yes]
 *
 *   bundle capabilities <bundle-id>
 *   bundle enable-app-groups <bundle-id> [--dry-run]
 *
 *   app-group check [--bundle-id <id>] [--extension-bundle-id <id>]
 *
 *   access check [--read-only] [--bundle-id <id>]
 *
 * 공통 옵션 (아무 명령어에나 붙일 수 있음, 안 주면 ios_credentials/에서 자동 탐색):
 *   --key <path>     AuthKey_<id>.p8 경로   (APP_STORE_CONNECT_KEY_PATH)
 *   --key-id <id>    Key ID, 기본 45D3A26734 (APP_STORE_CONNECT_KEY_ID)
 *   --issuer <id>    Issuer ID               (APP_STORE_CONNECT_ISSUER_ID)
 *
 * 예:
 *   node scripts/ios-asc.js cert list --type IOS_DISTRIBUTION
 *   node scripts/ios-asc.js profile list --bundle-id kr.inuappcenter.intip
 *   node scripts/ios-asc.js profile delete --name "INTIP App Store 20260903-1836" --keep-latest --yes
 *   node scripts/ios-asc.js app-group check
 *
 * 의존성 없음.
 */

const fs = require("node:fs");
const { createClient, findBundleId, consumeCommonFlag } = require("./lib/asc-client");

const DEFAULT_BUNDLE_ID = "kr.inuappcenter.intip"; // app.json ios.bundleIdentifier

function topLevelUsage(exitCode) {
  console.log(
    `사용법:\n` +
      `  node scripts/ios-asc.js cert list [--type <CertificateType>]\n` +
      `  node scripts/ios-asc.js cert revoke <certificate-id>\n\n` +
      `  node scripts/ios-asc.js profile list [--bundle-id <id>]\n` +
      `  node scripts/ios-asc.js profile reissue --bundle-id <id> [--certificate-id <id>]\n` +
      `                          [--profile-name <name>] [--out <path>] [--dry-run]\n` +
      `  node scripts/ios-asc.js profile delete (--name <name> | --profile-id <id>) [--keep-latest] [--yes]\n\n` +
      `  node scripts/ios-asc.js bundle capabilities <bundle-id>\n` +
      `  node scripts/ios-asc.js bundle enable-app-groups <bundle-id> [--dry-run]\n\n` +
      `  node scripts/ios-asc.js app-group check [--bundle-id <id>] [--extension-bundle-id <id>]\n\n` +
      `  node scripts/ios-asc.js access check [--read-only] [--bundle-id <id>]\n\n` +
      `공통 옵션 (안 주면 ios_credentials/ 자동 탐색):\n` +
      `  --key <path>   --key-id <id>   --issuer <id>\n`,
  );
  process.exit(exitCode);
}

/** 공통 --key/--key-id/--issuer 플래그를 걸러내고, 나머지 argv만 남긴다. */
function splitCommonFlags(argv) {
  const common = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const before = i;
    if (consumeCommonFlag(common, argv, i)) {
      i = argvIndexAfterConsume(argv, before);
      continue;
    }
    rest.push(argv[i]);
  }
  return { common, rest };
}
// consumeCommonFlag가 값 인자를 argv[++i]로 먹으므로, 몇 칸 건너뛰었는지 계산.
function argvIndexAfterConsume(argv, i) {
  const flag = argv[i];
  return ["--key", "--key-id", "--issuer"].includes(flag) ? i + 1 : i;
}

function timestampSuffix() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// ── cert ──────────────────────────────────────────────────────────────

async function certList(client, argv) {
  const args = { type: "IOS_DEVELOPMENT" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--type") args.type = argv[++i];
  }
  const data = await client.request(
    "GET",
    `/certificates?filter[certificateType]=${encodeURIComponent(args.type)}&limit=200`,
  );
  const now = new Date();
  if (!data.data.length) {
    console.log(`(${args.type} 인증서 없음)`);
    return;
  }
  for (const c of data.data) {
    const a = c.attributes;
    const expired = new Date(a.expirationDate) < now;
    console.log(
      `${c.id}\t${a.displayName}\t${a.certificateType}\tserial=${a.serialNumber}\texpires=${a.expirationDate}` +
        (expired ? "  ⚠️ EXPIRED" : ""),
    );
  }
}

async function certRevoke(client, argv) {
  const id = argv.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("인증서 id가 필요합니다: cert revoke <certificate-id>");
    process.exit(1);
  }
  await client.request("DELETE", `/certificates/${id}`);
  console.log(`✅ 해지됨: ${id}`);
}

// ── profile ───────────────────────────────────────────────────────────

async function profileList(client, argv) {
  const args = { bundleId: DEFAULT_BUNDLE_ID };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bundle-id") args.bundleId = argv[++i];
  }
  const resourceId = await findBundleId(client, args.bundleId);
  if (!resourceId) {
    console.error(`Bundle ID를 찾지 못했습니다: ${args.bundleId}`);
    process.exit(1);
  }
  const data = await client.request(
    "GET",
    `/bundleIds/${resourceId}/profiles?limit=200&fields[profiles]=name,profileState,createdDate,uuid`,
  );
  if (!data.data.length) {
    console.log(`(${args.bundleId}에 발급된 프로파일 없음)`);
    return;
  }
  const sorted = [...data.data].sort((a, b) => new Date(b.attributes.createdDate) - new Date(a.attributes.createdDate));
  for (const p of sorted) {
    const a = p.attributes;
    console.log(`${p.id}\t"${a.name}"\t${a.profileState}\tuuid=${a.uuid}\t발급일=${a.createdDate}`);
  }
}

async function profileReissue(client, argv) {
  const args = { bundleId: DEFAULT_BUNDLE_ID, out: "./INTIP.mobileprovision.base64" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bundle-id") args.bundleId = argv[++i];
    else if (a === "--certificate-id") args.certificateId = argv[++i];
    else if (a === "--profile-name") args.profileName = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
  }

  const bundleResourceId = await findBundleId(client, args.bundleId);
  if (!bundleResourceId) throw new Error(`Bundle ID를 찾지 못했습니다: ${args.bundleId}`);
  console.log(`Bundle ID 리소스: ${bundleResourceId}`);

  let certificateId = args.certificateId;
  if (!certificateId) {
    const certs = await client.request(
      "GET",
      `/certificates?filter[certificateType]=DISTRIBUTION,IOS_DISTRIBUTION&limit=200`,
    );
    const now = new Date();
    const valid = certs.data.filter((c) => new Date(c.attributes.expirationDate) >= now);
    if (valid.length === 1) {
      certificateId = valid[0].id;
      console.log(`Distribution 인증서 자동 선택: ${valid[0].attributes.displayName} (${certificateId})`);
    } else if (valid.length === 0) {
      throw new Error("유효한 Distribution 인증서가 없습니다.");
    } else {
      console.log("유효한 Distribution 인증서가 여러 개입니다 — --certificate-id로 하나를 지정하세요:");
      for (const c of valid) console.log(`  ${c.id}\t${c.attributes.displayName}`);
      process.exit(1);
    }
  }

  const profileName = args.profileName ?? `INTIP ${args.bundleId} ${timestampSuffix()}`;
  if (args.dryRun) {
    console.log(`[dry-run] POST /profiles 생략 — name="${profileName}", certificate=${certificateId}`);
    return;
  }

  const profile = await client.request("POST", "/profiles", {
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
  if (!content) throw new Error("응답에 profileContent가 없습니다:\n" + JSON.stringify(profile));
  fs.writeFileSync(args.out, content, "utf8");
  console.log(`✅ 새 프로파일 발급 완료: "${profileName}" (uuid ${profile.data.attributes.uuid})`);
  console.log(`   base64 저장: ${args.out}`);
}

async function profileDelete(client, argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") args.name = argv[++i];
    else if (a === "--profile-id") args.profileId = argv[++i];
    else if (a === "--keep-latest") args.keepLatest = true;
    else if (a === "--yes") args.yes = true;
  }
  if (!args.name && !args.profileId) {
    console.error("profile delete는 --name 또는 --profile-id가 필요합니다.");
    process.exit(1);
  }

  let targets;
  if (args.profileId) {
    const data = await client.request(
      "GET",
      `/profiles/${args.profileId}?fields[profiles]=name,profileState,createdDate,uuid`,
    );
    const p = data.data;
    targets = [{ id: p.id, name: p.attributes.name, state: p.attributes.profileState, uuid: p.attributes.uuid, createdDate: p.attributes.createdDate }];
  } else {
    const data = await client.request(
      "GET",
      `/profiles?filter[name]=${encodeURIComponent(args.name)}&limit=200&fields[profiles]=name,profileState,createdDate,uuid`,
    );
    targets = data.data
      .map((p) => ({ id: p.id, name: p.attributes.name, state: p.attributes.profileState, uuid: p.attributes.uuid, createdDate: p.attributes.createdDate }))
      .sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
    if (args.keepLatest && targets.length > 1) {
      const kept = targets[0];
      console.log(`--keep-latest: 최근 것 제외 → "${kept.name}" (uuid ${kept.uuid}, 발급일 ${kept.createdDate})\n`);
      targets = targets.slice(1);
    }
  }

  if (!targets.length) {
    console.log("대상 프로파일이 없습니다.");
    return;
  }

  console.log(`삭제 대상 ${targets.length}개:`);
  for (const t of targets) console.log(`  ${t.id}\t"${t.name}"\t${t.state}\tuuid=${t.uuid}\t발급일=${t.createdDate}`);

  if (!args.yes) {
    console.log("\n[조회만 함] 실제로 삭제하려면 --yes를 붙이세요.");
    return;
  }
  for (const t of targets) {
    await client.request("DELETE", `/profiles/${t.id}`);
    console.log(`✅ 삭제됨: ${t.id} ("${t.name}")`);
  }
}

// ── bundle ────────────────────────────────────────────────────────────

async function bundleCapabilities(client, argv) {
  const bundleId = argv.find((a) => !a.startsWith("--")) ?? DEFAULT_BUNDLE_ID;
  const resourceId = await findBundleId(client, bundleId);
  if (!resourceId) {
    console.error(`Bundle ID를 찾지 못했습니다: ${bundleId}`);
    process.exit(1);
  }
  const caps = await client.request("GET", `/bundleIds/${resourceId}/bundleIdCapabilities`);
  console.log(`${bundleId} (${resourceId})`);
  if (!caps.data.length) {
    console.log("  (capability 없음)");
    return;
  }
  for (const c of caps.data) console.log(`  ${c.attributes.capabilityType}`);
}

async function bundleEnableAppGroups(client, argv) {
  const args = {};
  const bundleId = argv.find((a) => !a.startsWith("--")) ?? DEFAULT_BUNDLE_ID;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
  }
  const resourceId = await findBundleId(client, bundleId);
  if (!resourceId) throw new Error(`Bundle ID를 찾지 못했습니다: ${bundleId}`);

  const caps = await client.request("GET", `/bundleIds/${resourceId}/bundleIdCapabilities`);
  const types = caps.data.map((c) => c.attributes.capabilityType);
  console.log(`현재 capability: ${types.length ? types.join(", ") : "(없음)"}`);
  if (types.includes("APP_GROUPS")) {
    console.log("✅ 이미 활성화되어 있음.");
    return;
  }
  if (args.dryRun) {
    console.log("[dry-run] POST /bundleIdCapabilities (APP_GROUPS)는 생략함.");
    return;
  }
  await client.request("POST", "/bundleIdCapabilities", {
    data: {
      type: "bundleIdCapabilities",
      attributes: { capabilityType: "APP_GROUPS", settings: [] },
      relationships: { bundleId: { data: { id: resourceId, type: "bundleIds" } } },
    },
  });
  console.log("✅ APP_GROUPS 활성화 완료.");
}

// ── app-group ─────────────────────────────────────────────────────────

/**
 * .mobileprovision은 CMS(PKCS#7) 서명만 돼 있고 암호화는 안 돼 있어서, 안에
 * 든 plist XML이 raw 바이트에 그대로 들어있다 — 전체 plist 파서 없이
 * Entitlements의 com.apple.security.application-groups 값을 문자열 검색으로
 * 뽑아낸다.
 */
function extractAppGroups(profileContentBase64) {
  const raw = Buffer.from(profileContentBase64, "base64").toString("latin1");
  const keyIdx = raw.indexOf("com.apple.security.application-groups");
  if (keyIdx === -1) return [];
  const arrayStart = raw.indexOf("<array>", keyIdx);
  const arrayEnd = raw.indexOf("</array>", arrayStart);
  if (arrayStart === -1 || arrayEnd === -1) return [];
  const groups = [];
  const re = /<string>([^<]*)<\/string>/g;
  let m;
  const block = raw.slice(arrayStart, arrayEnd);
  while ((m = re.exec(block))) groups.push(m[1]);
  return groups;
}

async function latestProfileFor(client, bundleResourceId) {
  const list = await client.request(
    "GET",
    `/bundleIds/${bundleResourceId}/profiles?limit=50&fields[profiles]=name,profileState,createdDate,uuid`,
  );
  if (!list.data.length) return null;
  const latest = [...list.data].sort((a, b) => new Date(b.attributes.createdDate) - new Date(a.attributes.createdDate))[0];
  const full = await client.request(
    "GET",
    `/profiles/${latest.id}?fields[profiles]=name,profileState,createdDate,uuid,profileContent`,
  );
  return full.data;
}

async function appGroupReportFor(client, label, bundleId) {
  console.log(`── [${label}] ${bundleId} ──`);
  const resourceId = await findBundleId(client, bundleId);
  if (!resourceId) {
    console.log(`  ❌ Bundle ID가 계정에 없음\n`);
    return { groups: [] };
  }
  const profile = await latestProfileFor(client, resourceId);
  if (!profile) {
    console.log(`  ⚠️ 발급된 프로파일이 없음 — profile reissue로 먼저 발급하세요.\n`);
    return { groups: [] };
  }
  const { name, createdDate, profileState, uuid } = profile.attributes;
  console.log(`  최근 프로파일: "${name}" (uuid ${uuid}, ${profileState}, 발급일 ${createdDate})`);
  const groups = extractAppGroups(profile.attributes.profileContent);
  console.log(groups.length ? `  ✅ App Group: ${groups.join(", ")}` : "  ❌ 이 프로파일 엔타이틀먼트에 App Group 없음");
  console.log();
  return { groups };
}

async function appGroupCheck(client, argv) {
  const args = { bundleId: DEFAULT_BUNDLE_ID };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bundle-id") args.bundleId = argv[++i];
    else if (argv[i] === "--extension-bundle-id") args.extensionBundleId = argv[++i];
  }
  args.extensionBundleId = args.extensionBundleId ?? `${args.bundleId}.share-extension`;

  console.log(`메인 앱 Bundle ID:      ${args.bundleId}`);
  console.log(`Extension Bundle ID:    ${args.extensionBundleId}\n`);

  const main_ = await appGroupReportFor(client, "메인 앱", args.bundleId);
  const ext = await appGroupReportFor(client, "Extension", args.extensionBundleId);

  console.log("── 결론 ──");
  const shared = main_.groups.filter((g) => ext.groups.includes(g));
  if (shared.length > 0) {
    console.log(`✅ 양쪽 최신 프로파일에 공통 App Group 확인됨: ${shared.join(", ")}`);
  } else {
    console.log("❌ 아직 양쪽 프로파일에 공통 App Group이 없음 (또는 재발급 전).");
  }
}

// ── access ────────────────────────────────────────────────────────────

async function accessCheck(client, argv) {
  const args = { bundleId: DEFAULT_BUNDLE_ID };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--read-only") args.readOnly = true;
    else if (argv[i] === "--bundle-id") args.bundleId = argv[++i];
  }

  console.log(`[읽기 테스트] ${args.bundleId}`);
  const resourceId = await findBundleId(client, args.bundleId);
  if (!resourceId) throw new Error(`Bundle ID를 찾지 못했습니다: ${args.bundleId}`);
  const caps = await client.request("GET", `/bundleIds/${resourceId}/bundleIdCapabilities`);
  console.log(`  ✅ 읽기 OK — 현재 capability: ${caps.data.map((c) => c.attributes.capabilityType).join(", ") || "(없음)"}`);

  if (args.readOnly) {
    console.log("\n--read-only: 쓰기 테스트 생략.");
    return;
  }

  console.log("\n[쓰기 테스트] 더미 Bundle ID 생성 → 삭제");
  const dummyId = `kr.inuappcenter.intip.asc-access-check.${Date.now()}`;
  let created;
  try {
    created = await client.request("POST", "/bundleIds", {
      data: { type: "bundleIds", attributes: { identifier: dummyId, name: "ASC access check (temp)", platform: "IOS" } },
    });
    console.log(`  ✅ 생성 OK: ${dummyId} (${created.data.id})`);
    console.log("  ✅ 쓰기 권한 있음 (Admin 롤 확인됨)");
  } catch (e) {
    console.log(`  ❌ 쓰기 실패: ${e.message}`);
  } finally {
    if (created?.data?.id) {
      await client.request("DELETE", `/bundleIds/${created.data.id}`);
      console.log(`  🧹 더미 Bundle ID 정리 완료`);
    }
  }
}

// ── dispatch ──────────────────────────────────────────────────────────

const COMMANDS = {
  cert: { list: certList, revoke: certRevoke },
  profile: { list: profileList, reissue: profileReissue, delete: profileDelete },
  bundle: { capabilities: bundleCapabilities, "enable-app-groups": bundleEnableAppGroups },
  "app-group": { check: appGroupCheck },
  access: { check: accessCheck },
};

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") topLevelUsage(0);

  const command = argv[0];
  const sub = argv[1];
  const group = COMMANDS[command];
  if (!group) {
    console.error(`알 수 없는 명령어: ${command}\n`);
    topLevelUsage(1);
  }
  const handler = group[sub];
  if (!handler) {
    console.error(`알 수 없는 서브커맨드: ${command} ${sub ?? ""}\n`);
    topLevelUsage(1);
  }

  const { common, rest } = splitCommonFlags(argv.slice(2));
  const client = createClient(common);
  await handler(client, rest);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
