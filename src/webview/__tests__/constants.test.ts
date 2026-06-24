import { describe, it, expect } from '@jest/globals';
import { isMainTabPath, normalizePath } from '../constants';

describe('normalizePath', () => {
  it('strips query and hash', () => {
    expect(normalizePath('/home?tab=1#section')).toBe('/home');
  });

  it('maps the bare /m prefix to root', () => {
    expect(normalizePath('/m')).toBe('/');
  });

  it('strips a leading /m mobile prefix', () => {
    expect(normalizePath('/m/home')).toBe('/home');
    expect(normalizePath('/m/chat/list')).toBe('/chat/list');
  });

  it('leaves non-prefixed paths untouched', () => {
    expect(normalizePath('/board/12')).toBe('/board/12');
    expect(normalizePath('/mypage')).toBe('/mypage');
  });

  it('does not treat /menu as a /m-prefixed path', () => {
    expect(normalizePath('/menu')).toBe('/menu');
  });
});

describe('isMainTabPath', () => {
  it('recognises each main tab', () => {
    for (const p of ['/', '/home', '/bus', '/chat/list', '/save', '/mypage', '/timetable']) {
      expect(isMainTabPath(p)).toBe(true);
    }
  });

  it('recognises main tabs behind the /m prefix', () => {
    expect(isMainTabPath('/m/home')).toBe(true);
    expect(isMainTabPath('/m')).toBe(true);
  });

  it('recognises main tabs with query strings', () => {
    expect(isMainTabPath('/home?from=push')).toBe(true);
  });

  it('rejects sub-page paths', () => {
    expect(isMainTabPath('/board/12')).toBe(false);
    expect(isMainTabPath('/chat/room/5')).toBe(false);
  });
});
