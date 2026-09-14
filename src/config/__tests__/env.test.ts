import { describe, it, expect } from '@jest/globals';
import { resolveApiBaseUrl } from '../env';

describe('resolveApiBaseUrl', () => {
  it('pairs the production portal with the production API', () => {
    expect(resolveApiBaseUrl('https://intip.inuappcenter.kr')).toBe('https://portal.inuappcenter.kr');
  });

  it('pairs the test portal with the dev API', () => {
    expect(resolveApiBaseUrl('https://intip-test.pages.dev/home')).toBe('https://portal-dev.inuappcenter.kr');
  });

  it('ignores an override that disagrees with a known web host', () => {
    // The exact mismatch that 401'd every widget call: production portal,
    // dev API from `.env`.
    expect(resolveApiBaseUrl('https://intip.inuappcenter.kr', 'https://portal-dev.inuappcenter.kr/')).toBe(
      'https://portal.inuappcenter.kr',
    );
  });

  it('uses the override for an unknown host, trimmed', () => {
    expect(resolveApiBaseUrl('http://localhost:5173', 'http://localhost:8080/')).toBe('http://localhost:8080');
  });

  it('falls back to the dev API when nothing else applies', () => {
    expect(resolveApiBaseUrl('not a url')).toBe('https://portal-dev.inuappcenter.kr');
  });
});
