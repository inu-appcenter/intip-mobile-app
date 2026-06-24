import { describe, it, expect } from '@jest/globals';
import { parseBridgeMessage } from '../bridge';

describe('parseBridgeMessage', () => {
  it('returns null for non-JSON input', () => {
    expect(parseBridgeMessage('not json')).toBeNull();
  });

  it('returns null for JSON that is not an object', () => {
    expect(parseBridgeMessage('42')).toBeNull();
    expect(parseBridgeMessage('"hello"')).toBeNull();
    expect(parseBridgeMessage('null')).toBeNull();
  });

  it('ignores unknown message types', () => {
    expect(parseBridgeMessage(JSON.stringify({ type: 'somethingElse' }))).toBeNull();
  });

  it('requires a string type', () => {
    expect(parseBridgeMessage(JSON.stringify({ type: 123 }))).toBeNull();
  });

  it('parses navigateTo with a valid payload', () => {
    const raw = JSON.stringify({
      type: 'navigateTo',
      payload: { path: '/board/12', url: 'https://intip.inuappcenter.kr/board/12' },
    });
    expect(parseBridgeMessage(raw)).toEqual({
      type: 'navigateTo',
      payload: { path: '/board/12', url: 'https://intip.inuappcenter.kr/board/12' },
    });
  });

  it('rejects navigateTo without a url', () => {
    expect(parseBridgeMessage(JSON.stringify({ type: 'navigateTo', payload: { path: '/x' } }))).toBeNull();
    expect(parseBridgeMessage(JSON.stringify({ type: 'navigateTo', payload: { url: '' } }))).toBeNull();
    expect(parseBridgeMessage(JSON.stringify({ type: 'navigateTo' }))).toBeNull();
  });

  it('defaults navigateTo path to an empty string when missing', () => {
    const raw = JSON.stringify({ type: 'navigateTo', payload: { url: 'https://intip.inuappcenter.kr/x' } });
    expect(parseBridgeMessage(raw)).toEqual({
      type: 'navigateTo',
      payload: { path: '', url: 'https://intip.inuappcenter.kr/x' },
    });
  });

  it('coerces string-payload types to a string', () => {
    expect(parseBridgeMessage(JSON.stringify({ type: 'routeChange', payload: '/home' }))).toEqual({
      type: 'routeChange',
      payload: '/home',
    });
    // Non-string payload is coerced to '' for string-payload types.
    expect(parseBridgeMessage(JSON.stringify({ type: 'logWebDiagnostics', payload: 99 }))).toEqual({
      type: 'logWebDiagnostics',
      payload: '',
    });
  });

  it('passes through payload-less control messages', () => {
    expect(parseBridgeMessage(JSON.stringify({ type: 'goBack' }))).toEqual({
      type: 'goBack',
      payload: undefined,
    });
  });
});
