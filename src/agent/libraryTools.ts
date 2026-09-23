import { ClientActionInstruction } from './agentActionExecutor';

const BASE_URL = 'https://lib.inu.ac.kr/pyxis-api';
const HOMEPAGE_ID = '1';

/**
 * AI 에이전트(LLM Function Calling)에서 참조할 수 있는 도구 정의 및 Instruction 빌더
 */
export const LibraryAgentTools = {
  /**
   * 1. 열람실 전체 좌석 현황 조회
   */
  getReadingRooms(): ClientActionInstruction {
    return {
      actionId: `act_lib_rooms_${Date.now()}`,
      authDomain: 'NONE', // 공개 API
      request: {
        method: 'GET',
        url: `${BASE_URL}/${HOMEPAGE_ID}/seat-rooms`,
        params: {
          branchGroupId: 1,
          smufMethodCode: 'PC',
        },
      },
    };
  },

  /**
   * 2. 특정 열람실의 좌석 배치도 및 좌석별 상세 상태 조회
   */
  getRoomSeats(roomId: number): ClientActionInstruction {
    return {
      actionId: `act_lib_seats_${roomId}_${Date.now()}`,
      authDomain: 'LIBRARY', // 로그인 필요
      request: {
        method: 'GET',
        url: `${BASE_URL}/${HOMEPAGE_ID}/api/rooms/${roomId}/seats`,
        params: {
          smufMethodCode: 'PC',
        },
      },
    };
  },

  /**
   * 3. 현재 내가 이용 중인 좌석 조회
   */
  getMyCurrentSeat(): ClientActionInstruction {
    return {
      actionId: `act_lib_my_seat_${Date.now()}`,
      authDomain: 'LIBRARY',
      request: {
        method: 'GET',
        url: `${BASE_URL}/${HOMEPAGE_ID}/api/seat-charges`,
      },
    };
  },

  /**
   * 4. 좌석 예약/배정 신청
   */
  reserveSeat(params: {
    seatId: number;
    beginTime?: string;
    endTime?: string;
  }): ClientActionInstruction {
    return {
      actionId: `act_lib_reserve_seat_${params.seatId}_${Date.now()}`,
      authDomain: 'LIBRARY',
      request: {
        method: 'POST',
        url: `${BASE_URL}/${HOMEPAGE_ID}/api/seat-charges`,
        body: {
          seatId: params.seatId,
          beginTime: params.beginTime,
          endTime: params.endTime,
          smufMethodCode: 'MOBILE',
        },
      },
    };
  },

  /**
   * 5. 좌석 이용 시간 연장
   */
  renewSeat(chargeId: number): ClientActionInstruction {
    return {
      actionId: `act_lib_renew_${chargeId}_${Date.now()}`,
      authDomain: 'LIBRARY',
      request: {
        method: 'POST',
        url: `${BASE_URL}/${HOMEPAGE_ID}/api/seat-renewed-charges`,
        body: {
          seatCharge: chargeId,
          smufMethodCode: 'MOBILE',
        },
      },
    };
  },

  /**
   * 6. 좌석 반납 (퇴실)
   */
  returnSeat(chargeId: number): ClientActionInstruction {
    return {
      actionId: `act_lib_return_${chargeId}_${Date.now()}`,
      authDomain: 'LIBRARY',
      request: {
        method: 'POST',
        url: `${BASE_URL}/${HOMEPAGE_ID}/api/seat-discharges`,
        body: {
          seatCharge: chargeId,
          smufMethodCode: 'MOBILE',
        },
      },
    };
  },

  /**
   * 7. 스터디룸 / 세미나실 등 공간 목록 조회
   */
  getStudyRooms(): ClientActionInstruction {
    return {
      actionId: `act_lib_study_rooms_${Date.now()}`,
      authDomain: 'LIBRARY',
      request: {
        method: 'GET',
        url: `${BASE_URL}/${HOMEPAGE_ID}/api/rooms`,
        params: {
          branchGroupId: 1,
        },
      },
    };
  },

  /**
   * 8. 나의 좌석 이용 이력 조회
   */
  getSeatUsageHistory(limit: number = 10, offset: number = 0): ClientActionInstruction {
    return {
      actionId: `act_lib_history_${Date.now()}`,
      authDomain: 'LIBRARY',
      request: {
        method: 'GET',
        url: `${BASE_URL}/${HOMEPAGE_ID}/api/seat-charge-histories`,
        params: {
          max: limit,
          offset,
        },
      },
    };
  },
};
