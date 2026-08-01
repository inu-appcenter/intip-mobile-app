import { describe, it, expect } from '@jest/globals';
import { PORTAL_HOST } from '../../webview/constants';
import { extractNavPath } from '../navPath';

describe('extractNavPath', () => {
  it('returns null when there is no data', () => {
    expect(extractNavPath(undefined)).toBeNull();
    expect(extractNavPath({})).toBeNull();
  });

  it('reads an absolute path directly', () => {
    expect(extractNavPath({ path: '/board/12' })).toBe('/board/12');
  });

  it('honours the path/route/link/url precedence', () => {
    expect(extractNavPath({ route: '/r' })).toBe('/r');
    expect(extractNavPath({ link: '/l' })).toBe('/l');
    expect(extractNavPath({ path: '/p', route: '/r' })).toBe('/p');
  });

  it('extracts path + search from a portal URL', () => {
    expect(extractNavPath({ url: `https://${PORTAL_HOST}/board/12?x=1` })).toBe('/board/12?x=1');
  });

  it('rejects URLs from other hosts', () => {
    expect(extractNavPath({ url: 'https://evil.example.com/board/12' })).toBeNull();
  });

  it('rejects non-string and empty candidates', () => {
    expect(extractNavPath({ path: 123 as unknown as string })).toBeNull();
    expect(extractNavPath({ path: '' })).toBeNull();
  });

  it('rejects malformed URLs that are not absolute paths', () => {
    expect(extractNavPath({ url: 'not a url' })).toBeNull();
  });
});
