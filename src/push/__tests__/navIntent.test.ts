import { describe, it, expect } from '@jest/globals';
import { resolveNavIntent } from '../navIntent';

describe('resolveNavIntent', () => {
  it('returns null when there is no data', () => {
    expect(resolveNavIntent(undefined)).toBeNull();
    expect(resolveNavIntent({})).toBeNull();
  });

  it('resolves an absolute portal path as kind "path"', () => {
    expect(resolveNavIntent({ path: '/board/12' })).toEqual({ kind: 'path', path: '/board/12' });
  });

  it('resolves a portal URL as kind "path" with search preserved', () => {
    expect(resolveNavIntent({ url: 'https://intip.inuappcenter.kr/board/12?x=1' })).toEqual({
      kind: 'path',
      path: '/board/12?x=1',
    });
  });

  it('resolves an allow-listed external host as kind "external"', () => {
    expect(resolveNavIntent({ path: 'https://inu.ac.kr/notice/123' })).toEqual({
      kind: 'external',
      url: 'https://inu.ac.kr/notice/123',
    });
  });

  it('resolves a subdomain of an allow-listed host as kind "external"', () => {
    expect(resolveNavIntent({ path: 'https://cse.inu.ac.kr/notice/123' })).toEqual({
      kind: 'external',
      url: 'https://cse.inu.ac.kr/notice/123',
    });
  });

  it('rejects a non-allow-listed external host', () => {
    expect(resolveNavIntent({ url: 'https://evil.example.com/board/12' })).toBeNull();
  });

  it('rejects a host that merely ends with the allow-listed domain as a substring', () => {
    // "notinu.ac.kr" is not a subdomain of "inu.ac.kr" — no dot boundary.
    expect(resolveNavIntent({ url: 'https://notinu.ac.kr/board/12' })).toBeNull();
    // Nor is a domain that happens to start with it, e.g. a lookalike suffix.
    expect(resolveNavIntent({ url: 'https://inu.ac.kr.evil.com/board/12' })).toBeNull();
  });

  it('rejects a non-http(s) scheme even on an allow-listed-looking host string', () => {
    expect(resolveNavIntent({ path: 'ftp://inu.ac.kr/notice/123' })).toBeNull();
  });

  it('rejects malformed URLs that are not absolute paths', () => {
    expect(resolveNavIntent({ url: 'not a url' })).toBeNull();
  });

  it('rejects non-string and empty candidates', () => {
    expect(resolveNavIntent({ path: 123 as unknown as string })).toBeNull();
    expect(resolveNavIntent({ path: '' })).toBeNull();
  });
});
