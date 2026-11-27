/**
 * 기준 분류기. Kotlin(RelayConfig.kt)·Swift(RelayNotificationIntent.swift) 구현이 이 동작을
 * 그대로 따라야 한다 — 규칙을 바꾸면 여기 케이스부터 늘린다.
 */
import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_RELAY_CONFIG,
  classifyNotification,
  validateRelayConfig,
  NotificationRelayConfig,
} from '../config';

describe('classifyNotification', () => {
  it('제목이나 내용에 키워드가 있으면 그 카테고리', () => {
    const r = classifyNotification(DEFAULT_RELAY_CONFIG, '[공지]', '자료구조 3주차 휴강 안내');
    expect(r.category.id).toBe('class');
    expect(r.matchedKeyword).toBe('휴강');
  });

  it('공백과 대소문자를 무시한다', () => {
    const config = {
      categories: [{ id: 'a', name: 'A', keywords: ['수강신청', 'LMS'] }],
      fallback: DEFAULT_RELAY_CONFIG.fallback,
    };
    expect(classifyNotification(config, '2학기 수강 신청 일정', '').category.id).toBe('a');
    expect(classifyNotification(config, '', 'lms 점검').category.id).toBe('a');
  });

  it('위에 있는 카테고리가 먼저 이긴다', () => {
    // "장학"(scholarship)보다 "등록금"(academic)이 위에 있다.
    const r = classifyNotification(DEFAULT_RELAY_CONFIG, '등록금 및 장학금 안내', null);
    expect(r.category.id).toBe('academic');
  });

  it('아무것도 안 걸리면 fallback', () => {
    const r = classifyNotification(DEFAULT_RELAY_CONFIG, '안녕하세요', undefined);
    expect(r.category.id).toBe('etc');
    expect(r.matchedKeyword).toBeNull();
  });

  it('빈 키워드는 모든 알림에 걸리지 않는다', () => {
    const config = {
      categories: [{ id: 'a', name: 'A', keywords: ['', '  '] }],
      fallback: DEFAULT_RELAY_CONFIG.fallback,
    };
    expect(classifyNotification(config, '아무 알림', '').category.id).toBe('etc');
  });
});

describe('validateRelayConfig', () => {
  it('기본 설정은 통과', () => {
    expect(validateRelayConfig(DEFAULT_RELAY_CONFIG)).toEqual([]);
  });

  it('잘못된 id, 중복 id, 키워드 없는 카테고리, 켜졌는데 패키지 없음', () => {
    const config: NotificationRelayConfig = {
      ...DEFAULT_RELAY_CONFIG,
      enabled: true,
      categories: [
        { id: 'Bad-Id', name: 'x', keywords: ['a'] },
        { id: 'dup', name: 'y', keywords: [''] },
      ],
      fallback: { id: 'dup', name: 'z', keywords: [] },
    };
    const problems = validateRelayConfig(config);
    expect(problems).toHaveLength(4);
  });
});
