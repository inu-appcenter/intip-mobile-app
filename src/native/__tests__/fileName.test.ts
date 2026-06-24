import { describe, it, expect } from '@jest/globals';
import { fileNameFromUrl } from '../fileName';

describe('fileNameFromUrl', () => {
  it('takes the last path segment', () => {
    expect(fileNameFromUrl('https://intip.inuappcenter.kr/files/report.pdf')).toBe('report.pdf');
  });

  it('ignores the query string', () => {
    expect(fileNameFromUrl('https://x.kr/a/b/notice.hwp?token=abc')).toBe('notice.hwp');
  });

  it('decodes percent-encoded names', () => {
    expect(fileNameFromUrl('https://x.kr/files/%EA%B3%B5%EC%A7%80.pdf')).toBe('공지.pdf');
  });

  it('falls back when there is no path segment', () => {
    expect(fileNameFromUrl('https://x.kr/')).toBe('download');
    expect(fileNameFromUrl('https://x.kr')).toBe('download');
  });

  it('uses the provided fallback', () => {
    expect(fileNameFromUrl('https://x.kr/', 'file.bin')).toBe('file.bin');
  });

  it('falls back for malformed URLs', () => {
    expect(fileNameFromUrl('not a url')).toBe('download');
  });
});
