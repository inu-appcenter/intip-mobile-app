import { describe, expect, it } from '@jest/globals';

import {
  ITSME_ANDROID_PACKAGE,
  ITSME_STORE_IDS,
  isItsmeLink,
  itsmeStoreUrl,
  itsmeStoreUrlFor,
} from '../itsmeLink';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../../../plugins/withItsmeQueries') as {
  ITSME_ANDROID_PACKAGE: string;
  addPackageQuery: (manifest: Record<string, unknown>, packageName: string) => Record<string, unknown>;
};

const STUDENT = '08db54d2-e344-4455-ae89-b73e7958d08a';

describe('itsmeStoreUrl', () => {
  it('builds the store App Link', () => {
    expect(itsmeStoreUrl(STUDENT)).toBe(`https://link.itsme.co.kr/store?storeId=${STUDENT}`);
    expect(itsmeStoreUrl(STUDENT, 'c1')).toBe(
      `https://link.itsme.co.kr/store?storeId=${STUDENT}&cornerId=c1`,
    );
  });

  it('maps the web cafeteria names, and skips ones itsme has no store for', () => {
    expect(itsmeStoreUrlFor('학생식당')).toBe(itsmeStoreUrl(STUDENT));
    expect(itsmeStoreUrlFor('2호관(교직원)식당')).toContain(ITSME_STORE_IDS['2호관(교직원)식당']);
    expect(itsmeStoreUrlFor('2기숙사 식당')).toBeNull();
  });
});

describe('isItsmeLink', () => {
  it.each([
    `https://link.itsme.co.kr/store?storeId=${STUDENT}`,
    'https://link.itsme.co.kr/app/home',
    'itsme://channeltalk',
    'ITSME://web?url=x',
  ])('accepts %s', (url) => expect(isItsmeLink(url)).toBe(true));

  it.each([
    'https://intip.inuappcenter.kr/home/menu',
    'https://link.itsme.co.kr.evil.com/store',
    'https://evil.com/?u=https://link.itsme.co.kr',
    'itsmefake://x',
    'not a url',
    '',
  ])('rejects %s', (url) => expect(isItsmeLink(url)).toBe(false));
});

describe('withItsmeQueries', () => {
  it('uses the same package name as the app code', () => {
    expect(plugin.ITSME_ANDROID_PACKAGE).toBe(ITSME_ANDROID_PACKAGE);
  });

  it('adds the package query once, keeping existing queries', () => {
    const manifest = { queries: [{ intent: [{ action: 'x' }] }] };
    plugin.addPackageQuery(manifest, ITSME_ANDROID_PACKAGE);
    plugin.addPackageQuery(manifest, ITSME_ANDROID_PACKAGE);
    expect(manifest.queries).toEqual([
      { intent: [{ action: 'x' }], package: [{ $: { 'android:name': ITSME_ANDROID_PACKAGE } }] },
    ]);
  });

  it('creates <queries> when the manifest has none', () => {
    expect(plugin.addPackageQuery({}, ITSME_ANDROID_PACKAGE)).toEqual({
      queries: [{ package: [{ $: { 'android:name': ITSME_ANDROID_PACKAGE } }] }],
    });
  });
});
