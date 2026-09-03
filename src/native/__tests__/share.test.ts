import { describe, it, expect, beforeEach, jest } from '@jest/globals';
// `jest.mock` calls below are hoisted above these imports by babel-jest, so
// `Platform`/`shareContent` see the mocked `react-native` module.
import { Platform } from 'react-native';
import { shareContent } from '../share';

type ShareResult = { action: string; activityType?: string | null };
const mockShare =
  jest.fn<(content: unknown, options?: unknown) => Promise<ShareResult>>();

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Share: {
    share: (content: unknown, options?: unknown) => mockShare(content, options),
    sharedAction: 'sharedAction',
    dismissedAction: 'dismissedAction',
  },
}));

function setPlatform(os: 'android' | 'ios'): void {
  (Platform as { OS: string }).OS = os;
}

describe('shareContent', () => {
  beforeEach(() => {
    mockShare.mockReset();
    setPlatform('android');
  });

  describe('files -> unsupported', () => {
    it('returns unsupported immediately without calling Share.share', async () => {
      const result = await shareContent({
        text: 'hello',
        files: [{ name: 'a.png', mimeType: 'image/png', src: 'data:image/png;base64,x' }],
      });
      expect(result.status).toBe('unsupported');
      expect(mockShare).not.toHaveBeenCalled();
    });
  });

  describe('empty payload -> error', () => {
    it('android: no text and no url', async () => {
      const result = await shareContent({});
      expect(result.status).toBe('error');
      expect(mockShare).not.toHaveBeenCalled();
    });

    it('ios: no text and no url', async () => {
      setPlatform('ios');
      const result = await shareContent({});
      expect(result.status).toBe('error');
      expect(mockShare).not.toHaveBeenCalled();
    });
  });

  describe('android message composition', () => {
    it('joins text and url with a newline', async () => {
      mockShare.mockResolvedValue({ action: 'sharedAction', activityType: null });
      await shareContent({ title: 't', text: 'hello', url: 'https://example.com' });
      expect(mockShare).toHaveBeenCalledWith(
        { title: 't', message: 'hello\nhttps://example.com' },
        { dialogTitle: undefined },
      );
    });

    it('url-only', async () => {
      mockShare.mockResolvedValue({ action: 'sharedAction', activityType: null });
      await shareContent({ url: 'https://example.com' });
      expect(mockShare).toHaveBeenCalledWith(
        { title: undefined, message: 'https://example.com' },
        { dialogTitle: undefined },
      );
    });

    it('text-only', async () => {
      mockShare.mockResolvedValue({ action: 'sharedAction', activityType: null });
      await shareContent({ text: 'hello' });
      expect(mockShare).toHaveBeenCalledWith(
        { title: undefined, message: 'hello' },
        { dialogTitle: undefined },
      );
    });

    it('passes dialogTitle through to Share.share options', async () => {
      mockShare.mockResolvedValue({ action: 'sharedAction', activityType: null });
      await shareContent({ text: 'hello', dialogTitle: 'Share via' });
      expect(mockShare).toHaveBeenCalledWith(
        { title: undefined, message: 'hello' },
        { dialogTitle: 'Share via' },
      );
    });
  });

  describe('ios message composition', () => {
    beforeEach(() => setPlatform('ios'));

    it('passes text and url as separate fields', async () => {
      mockShare.mockResolvedValue({ action: 'sharedAction', activityType: null });
      await shareContent({ title: 't', text: 'hello', url: 'https://example.com' });
      expect(mockShare).toHaveBeenCalledWith(
        { title: 't', message: 'hello', url: 'https://example.com' },
        { dialogTitle: undefined },
      );
    });
  });

  describe('result mapping', () => {
    it('maps sharedAction to shared, including a non-empty activityType', async () => {
      mockShare.mockResolvedValue({ action: 'sharedAction', activityType: 'com.example.App' });
      const result = await shareContent({ text: 'hi' });
      expect(result).toEqual({ status: 'shared', activityType: 'com.example.App' });
    });

    it('omits activityType when it is null', async () => {
      mockShare.mockResolvedValue({ action: 'sharedAction', activityType: null });
      const result = await shareContent({ text: 'hi' });
      expect(result).toEqual({ status: 'shared' });
    });

    it('omits activityType when it is an empty string', async () => {
      mockShare.mockResolvedValue({ action: 'sharedAction', activityType: '' });
      const result = await shareContent({ text: 'hi' });
      expect(result).toEqual({ status: 'shared' });
    });

    it('maps dismissedAction to dismissed', async () => {
      mockShare.mockResolvedValue({ action: 'dismissedAction', activityType: null });
      const result = await shareContent({ text: 'hi' });
      expect(result).toEqual({ status: 'dismissed' });
    });

    it('maps a thrown error to status "error" and never rejects', async () => {
      mockShare.mockRejectedValue(new Error('boom'));
      await expect(shareContent({ text: 'hi' })).resolves.toEqual({
        status: 'error',
        message: 'Error: boom',
      });
    });
  });
});
