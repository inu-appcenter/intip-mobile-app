import { describe, it, expect, jest } from '@jest/globals';
jest.mock('@notifee/react-native', () => ({ __esModule: true, default: {}, AndroidCategory: {}, AndroidImportance: {}, AndroidStyle: {}, AndroidVisibility: {} }));
jest.mock('expo-widgets', () => ({ after: jest.fn(), createLiveActivity: jest.fn(() => ({ getInstances: () => [] })) }));
jest.mock('../../agent/agentActionExecutor', () => ({ executeAgentAction: jest.fn() }));
jest.mock('../../agent/libraryTools', () => ({ LibraryAgentTools: {} }));
jest.mock('../../agent/localWatchManager', () => ({}));

import type { LocalWatchJob } from '../../agent/localWatchManager';
import { watchLabels } from '../libraryOngoingService';

const base: LocalWatchJob = {
  id: 'j', type: 'SPECIFIC_SEAT_SNIPER', title: '', targetName: '', createdAt: 0, expiresAt: 1, status: 'ACTIVE',
};

describe('watchLabels', () => {
  it('좌석: 헤드라인엔 좌석번호만', () => {
    expect(
      watchLabels({ ...base, targetName: 'ICT라운지 (이룸관B1F) BFB-003번', roomName: 'ICT라운지 (이룸관B1F)', seatNo: 'BFB-003' }),
    ).toEqual({ primary: 'BFB-003번', place: 'ICT라운지 (이룸관B1F)' });
  });

  it('열람실: 이름 + 빈자리, 괄호 속 위치는 보조 줄로', () => {
    expect(watchLabels({ ...base, type: 'ROOM_ANY_SEAT', targetName: 'ICT라운지 (이룸관B1F)', roomName: 'ICT라운지 (이룸관B1F)' })).toEqual({
      primary: 'ICT라운지 빈자리',
      place: '이룸관B1F',
    });
    expect(watchLabels({ ...base, type: 'ROOM_ANY_SEAT', targetName: '제1열람실', roomName: '제1열람실' })).toEqual({
      primary: '제1열람실 빈자리',
      place: undefined,
    });
  });

  it('스터디룸: "이용 가능한 스터디룸" + 방 이름', () => {
    expect(
      watchLabels({ ...base, type: 'STUDY_ROOM_SNIPER', targetName: '그룹스터디실 3 (14시)', roomName: '그룹스터디실 3', targetHour: 14 }),
    ).toEqual({ primary: '이용 가능한 스터디룸', place: '그룹스터디실 3' });
  });

  it('예전 스터디룸 작업(roomName 없음)은 targetName에서 시간을 떼어 쓴다', () => {
    expect(watchLabels({ ...base, type: 'STUDY_ROOM_SNIPER', targetName: '그룹스터디실 3 (14시)', targetHour: 14 }).place).toBe('그룹스터디실 3');
  });
});
