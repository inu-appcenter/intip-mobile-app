import { describe, it, expect } from '@jest/globals';
import { resolveDeepLink } from '../deepLink';
import { ROOT_URL } from '../../webview/constants';

describe('resolveDeepLink', () => {
  it('routes a main-tab path through the root WebView (spa)', () => {
    expect(resolveDeepLink('https://intip.inuappcenter.kr/home')).toEqual({
      kind: 'spa',
      path: '/home',
    });
  });

  it('treats the /m mobile prefix as the same main tab', () => {
    expect(resolveDeepLink('https://intip.inuappcenter.kr/m/home')).toEqual({
      kind: 'spa',
      path: '/m/home',
    });
  });

  it('pushes a native sub-page for everything else, query string intact', () => {
    expect(
      resolveDeepLink('https://intip.inuappcenter.kr/councilnoticedetail?id=456'),
    ).toEqual({
      kind: 'push',
      path: '/councilnoticedetail?id=456',
      url: `${ROOT_URL}/councilnoticedetail?id=456`,
    });
  });

  it('normalizes the origin: a link on the other portal host still opens on ROOT_URL', () => {
    // Both hosts are claimed, but the two WebViews share the login token
    // through one origin's localStorage — a sub-page on the other host would
    // come up logged out.
    const intent = resolveDeepLink('https://intip-test.pages.dev/friend/invite/ABC123');
    expect(intent).toEqual({
      kind: 'push',
      path: '/friend/invite/ABC123',
      url: `${ROOT_URL}/friend/invite/ABC123`,
    });
  });

  it('keeps the fragment on the pushed URL', () => {
    expect(resolveDeepLink('https://intip.inuappcenter.kr/phonebook#top')).toEqual({
      kind: 'push',
      path: '/phonebook#top',
      url: `${ROOT_URL}/phonebook#top`,
    });
  });

  it('hands the static legal pages back to a browser', () => {
    const url = 'https://intip.inuappcenter.kr/privacy-policy.html';
    expect(resolveDeepLink(url)).toEqual({ kind: 'external', url });
    const terms = 'https://intip.inuappcenter.kr/terms-of-use.html';
    expect(resolveDeepLink(terms)).toEqual({ kind: 'external', url: terms });
  });

  it('hands the domain-association files back to a browser', () => {
    const url = 'https://intip.inuappcenter.kr/.well-known/assetlinks.json';
    expect(resolveDeepLink(url)).toEqual({ kind: 'external', url });
  });

  it('ignores other hosts, other schemes and non-URLs', () => {
    expect(resolveDeepLink('https://inu.ac.kr/notice/1')).toBeNull();
    expect(resolveDeepLink('https://evil.example.com/home')).toBeNull();
    // A look-alike subdomain must not match either — the host list is exact.
    expect(resolveDeepLink('https://intip.inuappcenter.kr.evil.com/home')).toBeNull();
    expect(resolveDeepLink('intipmobileapp://webview?url=x')).toBeNull();
    expect(resolveDeepLink('/home')).toBeNull();
    expect(resolveDeepLink('')).toBeNull();
  });
});
