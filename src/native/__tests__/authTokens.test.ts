import { isExpired, parseNaiveLocal } from '../authTokens';

describe('parseNaiveLocal', () => {
  it('parses a naive datetime as device-local time, not UTC', () => {
    const parsed = parseNaiveLocal('2025-01-22T23:25:47.754524713');
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(new Date(2025, 0, 22, 23, 25, 47, 754));
  });

  it('parses without a fractional-seconds component', () => {
    const parsed = parseNaiveLocal('2025-01-22T23:25:47');
    expect(parsed).toEqual(new Date(2025, 0, 22, 23, 25, 47, 0));
  });

  it('returns null for an unparseable string', () => {
    expect(parseNaiveLocal('not-a-date')).toBeNull();
    expect(parseNaiveLocal('')).toBeNull();
  });
});

describe('isExpired', () => {
  it('is false when the expiry is in the future', () => {
    const now = new Date(2025, 0, 22, 12, 0, 0);
    expect(isExpired('2025-01-22T23:25:47.754', now)).toBe(false);
  });

  it('is true when the expiry is in the past', () => {
    const now = new Date(2025, 0, 23, 0, 0, 0);
    expect(isExpired('2025-01-22T23:25:47.754', now)).toBe(true);
  });

  it('treats an unparseable expiry as expired (fail safe)', () => {
    expect(isExpired('garbage', new Date())).toBe(true);
  });
});
