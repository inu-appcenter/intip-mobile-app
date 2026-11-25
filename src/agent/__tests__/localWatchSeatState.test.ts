import { describe, it, expect, jest } from '@jest/globals';
jest.mock('@notifee/react-native', () => ({ __esModule: true, default: {}, AndroidImportance: {}, TriggerType: {} }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-location', () => ({}));
jest.mock('expo-task-manager', () => ({}));
jest.mock('../agentActionExecutor', () => ({ executeAgentAction: jest.fn() }));
jest.mock('../../library/libraryOngoingService', () => ({ LibraryOngoingService: {} }));

import { availableSeatCount, isSeatFree } from '../localWatchManager';

describe('isSeatFree', () => {
  it('비어 있고 활성인 좌석만 빈자리', () => {
    expect(isSeatFree({ isOccupied: false, isActive: true })).toBe(true);
    expect(isSeatFree({ isOccupied: true, isReservable: true })).toBe(false);
    expect(isSeatFree({ isOccupied: false, seatChargeState: 'CHARGE' })).toBe(false);
    expect(isSeatFree({ isOccupied: false, isActive: false })).toBe(false);
    expect(isSeatFree(undefined)).toBe(false);
  });
});

describe('availableSeatCount', () => {
  it('seats.available 우선, 없으면 total-occupied', () => {
    expect(availableSeatCount({ seats: { total: 100, occupied: 100, available: 0 } })).toBe(0);
    expect(availableSeatCount({ availableSeats: 3 })).toBe(3);
    expect(availableSeatCount({ totalSeats: 10, occupiedSeats: 7 })).toBe(3);
    expect(availableSeatCount(undefined)).toBe(0);
  });
});
