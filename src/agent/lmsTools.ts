import { ClientActionInstruction } from './agentActionExecutor';

const LMS_SERVER_URL = 'https://lms.inu.ac.kr/webservice/rest/server.php';

/**
 * LMS(사이버캠퍼스) AI 에이전트 도구 빌더
 */
export const LmsAgentTools = {
  /**
   * 1. 수강 중인 강좌 목록 조회 (core_enrol_get_users_courses)
   */
  getCourses(userId: number): ClientActionInstruction {
    return {
      actionId: `act_lms_courses_${Date.now()}`,
      authDomain: 'LMS',
      request: {
        method: 'GET',
        url: LMS_SERVER_URL,
        params: {
          wsfunction: 'core_enrol_get_users_courses',
          userid: userId,
        },
      },
    };
  },

  /**
   * 2. 다가오는 과제 / 퀴즈 / 일정 조회 (core_calendar_get_action_events_by_timesort)
   */
  getUpcomingAssignments(daysAhead: number = 14): ClientActionInstruction {
    const now = Math.floor(Date.now() / 1000);
    const timesortfrom = now - 86400 * 2; // 이틀 전부터
    const timesortto = now + 86400 * daysAhead; // 앞으로 N일까지

    return {
      actionId: `act_lms_upcoming_${Date.now()}`,
      authDomain: 'LMS',
      request: {
        method: 'GET',
        url: LMS_SERVER_URL,
        params: {
          wsfunction: 'core_calendar_get_action_events_by_timesort',
          timesortfrom,
          timesortto,
          limitnum: 15,
        },
      },
    };
  },

  /**
   * 3. 특정 과목의 과제 목록 상세 조회 (mod_assign_get_assignments)
   */
  getCourseAssignments(courseId: number): ClientActionInstruction {
    return {
      actionId: `act_lms_assign_${courseId}_${Date.now()}`,
      authDomain: 'LMS',
      request: {
        method: 'GET',
        url: LMS_SERVER_URL,
        params: {
          wsfunction: 'mod_assign_get_assignments',
          'courseids[0]': courseId,
        },
      },
    };
  },

  /**
   * 4. 특정 강좌의 주차별 강의자료 및 콘텐츠 조회 (core_course_get_contents)
   */
  getCourseContents(courseId: number): ClientActionInstruction {
    return {
      actionId: `act_lms_contents_${courseId}_${Date.now()}`,
      authDomain: 'LMS',
      request: {
        method: 'GET',
        url: LMS_SERVER_URL,
        params: {
          wsfunction: 'core_course_get_contents',
          courseid: courseId,
        },
      },
    };
  },
};
