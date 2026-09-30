import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { TimetableNowBarService } from '../timetableNowBarService';
import { TimetableLiveActivity } from '../../widgets/TimetableLiveActivity';
import { TimetableActivityState } from '../types';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {},
  AndroidCategory: {},
  AndroidImportance: {},
  AndroidStyle: {},
  AndroidVisibility: {},
}));

jest.mock('../timetableStorage', () => ({
  TimetableStorage: { getSettings: async () => ({ enabled: true, leadTimeMinutes: 15 }) },
}));

const liveActivity = TimetableLiveActivity as unknown as {
  start: jest.Mock;
  getInstances: jest.Mock;
};

function instance() {
  return {
    update: jest.fn(() => Promise.resolve()),
    end: jest.fn(() => Promise.resolve()),
  };
}

const upcoming: TimetableActivityState = {
  phase: 'UPCOMING',
  courseTitle: '운영체제',
  startTimestamp: Date.now() + 10 * 60 * 1000,
  endTimestamp: Date.now() + 85 * 60 * 1000,
};

describe('TimetableNowBarService (iOS Live Activity)', () => {
  beforeEach(async () => {
    liveActivity.start.mockReset();
    liveActivity.getInstances.mockReset();
    liveActivity.getInstances.mockReturnValue([]);
    await TimetableNowBarService.cancel(); // reset the last-props cache
    liveActivity.getInstances.mockReset();
  });

  it('starts UPCOMING when nothing is running', async () => {
    liveActivity.getInstances.mockReturnValue([]);
    await TimetableNowBarService.renderActivity(upcoming);
    expect(liveActivity.start).toHaveBeenCalledTimes(1);
  });

  it('leaves UPCOMING to the server push when startUpcoming is false', async () => {
    liveActivity.getInstances.mockReturnValue([]);
    await TimetableNowBarService.renderActivity(upcoming, { startUpcoming: false });
    expect(liveActivity.start).not.toHaveBeenCalled();
  });

  it('still starts ONGOING when startUpcoming is false', async () => {
    liveActivity.getInstances.mockReturnValue([]);
    await TimetableNowBarService.renderActivity({ ...upcoming, phase: 'ONGOING' }, { startUpcoming: false });
    expect(liveActivity.start).toHaveBeenCalledTimes(1);
  });

  it('updates a running activity (e.g. one the server started) instead of starting another', async () => {
    const running = instance();
    liveActivity.getInstances.mockReturnValue([running]);
    await TimetableNowBarService.renderActivity(upcoming, { startUpcoming: false });
    expect(running.update).toHaveBeenCalledTimes(1);
    expect(liveActivity.start).not.toHaveBeenCalled();
  });

  it('ends duplicates and keeps one', async () => {
    const first = instance();
    const second = instance();
    liveActivity.getInstances.mockReturnValue([first, second]);
    await TimetableNowBarService.renderActivity(upcoming);
    expect(first.update).toHaveBeenCalledTimes(1);
    expect(first.end).not.toHaveBeenCalled();
    expect(second.end).toHaveBeenCalledWith('immediate');
  });
});
