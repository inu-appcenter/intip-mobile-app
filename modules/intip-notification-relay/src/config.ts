/**
 * 알림 재분류(notification relay) 설정 스키마와 기준 분류기.
 *
 * 분류는 JS가 아니라 네이티브에서 돈다 — Android는 `RelayListenerService`(앱이 꺼져 있어도
 * 시스템이 바인드), iOS는 단축어 자동화가 부르는 App Intent(JS 런타임 없이 백그라운드 실행).
 * 그래서 JS는 이 설정을 JSON 문자열로 네이티브 저장소(SharedPreferences / UserDefaults)에
 * 써 주기만 하고, 분류 로직은 세 군데에 같은 규칙으로 들어 있다:
 *
 * - 여기 `classifyNotification` — 기준 구현. 설정 화면의 "이 알림은 어디로?" 미리보기와 테스트용.
 * - `android/.../RelayConfig.kt` 의 `classify`
 * - `plugins/notification-relay-ios/RelayNotificationIntent.swift` 의 `NotificationRelayClassifier`
 *
 * 규칙을 바꾸면 세 곳을 같이 바꾸고 `__tests__/config.test.ts` 케이스를 늘린다.
 */

export type RelayImportance = 'high' | 'default' | 'low';

export interface RelayCategory {
  /** 영문 소문자/숫자/_ 만. Android 채널 id(`intip_relay_<id>`)와 iOS threadIdentifier에 쓰인다. */
  id: string;
  /** 사용자에게 보이는 이름. 다시 보내는 알림 제목 앞에 `[이름]`으로 붙는다. */
  name: string;
  /** 제목+내용에 하나라도 포함되면 이 카테고리(대소문자·공백 무시). fallback에서는 무시된다. */
  keywords: string[];
  importance?: RelayImportance;
  /** true면 다시 보내지 않고 버린다(원본도 지운다). 광고성 알림 정리용. */
  drop?: boolean;
}

export interface NotificationRelayConfig {
  version: 1;
  enabled: boolean;
  android: {
    /** 가로챌 앱 패키지명. 스마트캠퍼스 패키지명은 기기에서 `getActiveNotificationSources()`로 확인. */
    sourcePackages: string[];
    /** 원본 알림을 지울지. false면 원본은 그대로 두고 분류된 사본만 추가로 띄운다(디버깅용). */
    cancelOriginal: boolean;
  };
  /** 위에서부터 검사해 처음 걸린 카테고리로 간다. */
  categories: RelayCategory[];
  /** 아무 키워드에도 안 걸린 알림. */
  fallback: RelayCategory;
}

export interface RelayClassification {
  category: RelayCategory;
  /** 걸린 키워드. fallback이면 null. */
  matchedKeyword: string | null;
}

/** TODO(실기기 확인): 스마트캠퍼스 Android 패키지명. 확인 전까지는 비워 두고 설정에서 채운다. */
export const SMART_CAMPUS_PACKAGE_PLACEHOLDER = '';

/**
 * 기본 카테고리. 실제 스마트캠퍼스 알림 문구를 모아 보고 다듬어야 한다 — 지금은 추측치.
 */
export const DEFAULT_RELAY_CONFIG: NotificationRelayConfig = {
  version: 1,
  enabled: false,
  android: {
    sourcePackages: [],
    cancelOriginal: true,
  },
  categories: [
    {
      id: 'class',
      name: '수업',
      keywords: ['휴강', '보강', '강의실', '출석', '과제', '시험', '수업'],
      importance: 'high',
    },
    {
      id: 'academic',
      name: '학사',
      keywords: ['수강신청', '등록금', '성적', '졸업', '휴학', '복학', '학사'],
      importance: 'high',
    },
    {
      id: 'scholarship',
      name: '장학',
      keywords: ['장학'],
      importance: 'default',
    },
    {
      id: 'career',
      name: '취업',
      keywords: ['채용', '취업', '인턴', '공모전'],
      importance: 'default',
    },
    {
      id: 'event',
      name: '행사',
      keywords: ['특강', '행사', '설명회', '모집', '축제', '참가'],
      importance: 'low',
    },
  ],
  fallback: { id: 'etc', name: '기타', keywords: [], importance: 'low' },
};

/** 공백 제거 + 소문자. "수강 신청"과 "수강신청"을 같게 본다. 네이티브 구현도 똑같이 한다. */
export function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

export function classifyNotification(
  config: Pick<NotificationRelayConfig, 'categories' | 'fallback'>,
  title: string | null | undefined,
  body: string | null | undefined,
): RelayClassification {
  const haystack = normalizeForMatch(`${title ?? ''}\n${body ?? ''}`);
  for (const category of config.categories) {
    for (const keyword of category.keywords) {
      const needle = normalizeForMatch(keyword);
      if (needle.length > 0 && haystack.includes(needle)) {
        return { category, matchedKeyword: keyword };
      }
    }
  }
  return { category: config.fallback, matchedKeyword: null };
}

const CATEGORY_ID = /^[a-z0-9_]{1,32}$/;

/**
 * 네이티브로 넘기기 전 검증. 네이티브 파서도 방어적으로 읽지만, 잘못된 id는 채널을 엉뚱하게
 * 만들 수 있으니 여기서 막는다. 문제 목록을 돌려주고, 비어 있으면 통과.
 */
export function validateRelayConfig(config: NotificationRelayConfig): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const category of [...config.categories, config.fallback]) {
    if (!CATEGORY_ID.test(category.id)) {
      problems.push(`카테고리 id "${category.id}"는 영문 소문자/숫자/_ 1~32자여야 합니다.`);
    }
    if (ids.has(category.id)) problems.push(`카테고리 id "${category.id}"가 중복됩니다.`);
    ids.add(category.id);
    if (category.name.trim().length === 0) problems.push(`카테고리 "${category.id}"의 이름이 비어 있습니다.`);
  }
  for (const category of config.categories) {
    if (category.keywords.every((k) => normalizeForMatch(k).length === 0)) {
      problems.push(`카테고리 "${category.name}"에 키워드가 없습니다.`);
    }
  }
  if (config.enabled && config.android.sourcePackages.length === 0) {
    // iOS는 단축어 자동화 쪽에서 앱을 고르므로 Android에만 해당하는 경고.
    problems.push('Android: 가로챌 앱 패키지명이 없습니다.');
  }
  return problems;
}
