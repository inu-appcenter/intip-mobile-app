import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// jest.mock calls below are hoisted above this import by babel-jest.
import { ITSME_LINK_DELAY_MS, openItsmeLink } from '../openItsme';

const mockOpenApplication = jest.fn();
const mockOpenURL = jest.fn<(url: string) => Promise<void>>();
const mockPlatform = { OS: 'android' };

jest.mock('expo-intent-launcher', () => ({
  openApplication: (name: string) => mockOpenApplication(name),
}));
jest.mock('react-native', () => ({
  Linking: { openURL: (url: string) => mockOpenURL(url) },
  Platform: {
    get OS() {
      return mockPlatform.OS;
    },
  },
}));

const LINK = 'https://link.itsme.co.kr/store?storeId=abc';

describe('openItsmeLink', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockOpenApplication.mockReset();
    mockOpenURL.mockReset();
    mockOpenURL.mockResolvedValue(undefined);
    mockPlatform.OS = 'android';
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('android: launches itsme first, then sends the link after a delay', async () => {
    const done = openItsmeLink(LINK);
    expect(mockOpenApplication).toHaveBeenCalledWith('id.itsme.mobile');
    expect(mockOpenURL).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(ITSME_LINK_DELAY_MS);
    await done;
    expect(mockOpenURL).toHaveBeenCalledWith(LINK);
  });

  it('android: not installed -> Play Store, never the link', async () => {
    mockOpenApplication.mockImplementation(() => {
      throw new Error('PackageNotFoundException');
    });
    await openItsmeLink(LINK);
    expect(mockOpenURL).toHaveBeenCalledTimes(1);
    expect(mockOpenURL).toHaveBeenCalledWith('market://details?id=id.itsme.mobile');
  });

  it('android: no Play Store app -> web listing', async () => {
    mockOpenApplication.mockImplementation(() => {
      throw new Error('PackageNotFoundException');
    });
    mockOpenURL.mockRejectedValueOnce(new Error('no market handler'));
    await openItsmeLink(LINK);
    expect(mockOpenURL).toHaveBeenLastCalledWith(
      'https://play.google.com/store/apps/details?id=id.itsme.mobile',
    );
  });

  it('ios: opens the Universal Link directly', async () => {
    mockPlatform.OS = 'ios';
    await openItsmeLink(LINK);
    expect(mockOpenApplication).not.toHaveBeenCalled();
    expect(mockOpenURL).toHaveBeenCalledWith(LINK);
  });

  it('never throws when opening fails', async () => {
    mockPlatform.OS = 'ios';
    mockOpenURL.mockRejectedValue(new Error('boom'));
    await expect(openItsmeLink(LINK)).resolves.toBeUndefined();
  });
});
