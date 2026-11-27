/**
 * The relay config is written by the Expo module (pod) and read by the App
 * Intent (main app target), which can't import each other — they share
 * UserDefaults keys by string. Pin that they stay in sync.
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const keysIn = (source: string) =>
  [...source.matchAll(/"(intip\.notificationRelay\.[A-Za-z]+)"/g)].map((m) => m[1]).sort();

describe('notification relay UserDefaults keys', () => {
  it('module and intent use the same keys', () => {
    const moduleKeys = keysIn(read('modules/intip-notification-relay/ios/IntipNotificationRelayModule.swift'));
    const intentKeys = keysIn(read('plugins/notification-relay-ios/RelayNotificationIntent.swift'));
    expect(moduleKeys).toEqual(['intip.notificationRelay.config', 'intip.notificationRelay.recent']);
    expect(intentKeys).toEqual(moduleKeys);
  });
});
