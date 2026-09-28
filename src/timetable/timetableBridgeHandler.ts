import { TimetableStorage } from './timetableStorage';
import { TimetableScheduler } from './timetableScheduler';
import { TimetableNowBarService } from './timetableNowBarService';
import { TimetableCourseItem } from './types';

export interface TimetableBridgeResponse {
  type: string;
  requestId?: string;
  success: boolean;
  data?: any;
  errorMessage?: string;
}

/**
 * 웹뷰로부터 들어오는 시간표 관련 브릿지 메시지 핸들러
 */
export async function handleTimetableBridgeMessage(
  raw: string,
  sendResponse: (res: TimetableBridgeResponse) => void
): Promise<boolean> {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
    return false;
  }

  const { type, payload } = parsed;
  const requestId = parsed.requestId;

  const reply = (res: Omit<TimetableBridgeResponse, 'type' | 'requestId'> & { type: string }) => {
    sendResponse({
      ...res,
      ...(requestId ? { requestId } : {}),
    });
  };

  switch (type) {
    case 'syncTimetable': {
      try {
        const rawCourses: any[] = Array.isArray(payload?.courses) ? payload.courses : [];
        const courses: TimetableCourseItem[] = rawCourses.map((c) => ({
          id: c.id,
          title: String(c.title || '강의'),
          professor: c.professor ? String(c.professor) : null,
          meetings: Array.isArray(c.meetings)
            ? c.meetings.map((m: any) => ({
                id: m.id,
                day: m.day,
                startTime: m.startTime,
                endTime: m.endTime,
                location: m.location ? String(m.location) : null,
              }))
            : [],
        }));

        await TimetableStorage.saveTimetableData(courses);
        const state = await TimetableScheduler.syncSchedule();

        reply({
          type: 'syncTimetableResult',
          success: true,
          data: {
            savedCount: courses.length,
            currentState: state,
          },
        });
      } catch (err: any) {
        reply({
          type: 'syncTimetableResult',
          success: false,
          errorMessage: err?.message || '시간표 동기화 실패',
        });
      }
      return true;
    }

    case 'getTimetableNowBarSettings': {
      try {
        const settings = await TimetableStorage.getSettings();
        reply({
          type: 'getTimetableNowBarSettingsResult',
          success: true,
          data: settings,
        });
      } catch (err: any) {
        reply({
          type: 'getTimetableNowBarSettingsResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    case 'setTimetableNowBarSettings': {
      try {
        const updated = await TimetableStorage.saveSettings(payload || {});
        const state = await TimetableScheduler.syncSchedule();
        reply({
          type: 'setTimetableNowBarSettingsResult',
          success: true,
          data: {
            settings: updated,
            currentState: state,
          },
        });
      } catch (err: any) {
        reply({
          type: 'setTimetableNowBarSettingsResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    case 'testTimetableNowBar': {
      // 즉시 테스트용 진행 중 액티비티 노출 및 상태 보존
      try {
        const now = Date.now();
        const durationMinutes = payload?.minutes || 75;
        const endTimestamp = now + durationMinutes * 60 * 1000;
        const testState = {
          phase: 'ONGOING' as const,
          courseTitle: payload?.title || '테스트 강의 (알고리즘)',
          location: payload?.location || '정보기술대학 7호관 314호',
          professor: payload?.professor || '홍길동 교수님',
          startTimestamp: now,
          endTimestamp,
          durationMinutes,
          elapsedMinutes: 0,
        };
        await TimetableStorage.saveTestActivity(testState);
        await TimetableNowBarService.renderActivity(testState);
        reply({
          type: 'testTimetableNowBarResult',
          success: true,
          data: { active: true },
        });
      } catch (err: any) {
        reply({
          type: 'testTimetableNowBarResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    case 'cancelTimetableNowBar': {
      try {
        await TimetableStorage.clearTestActivity();
        await TimetableNowBarService.cancel();
        reply({
          type: 'cancelTimetableNowBarResult',
          success: true,
          data: { active: false },
        });
      } catch (err: any) {
        reply({
          type: 'cancelTimetableNowBarResult',
          success: false,
          errorMessage: err?.message,
        });
      }
      return true;
    }

    default:
      return false;
  }
}
