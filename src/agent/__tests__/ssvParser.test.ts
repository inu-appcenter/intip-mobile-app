import { describe, it, expect } from '@jest/globals';
import { parseAcademicBasicInfo, parseRows } from '../ssvParser';

describe('Academic SSV Parser', () => {
  const RECORD_SEPARATOR = String.fromCharCode(30);
  const UNIT_SEPARATOR = String.fromCharCode(31);

  it('올바른 SSV 패킷으로부터 학적 기본 정보를 정상 파싱해야 한다', () => {
    // 가상의 ERP 응답 SSV 패킷 구성
    const mockSsv = [
      'ErrorCode:int=0',
      'ErrorMsg:String=SUCCESS',
      'Dataset:DS_SREG101',
      `_Column_${UNIT_SEPARATOR}stuno:string${UNIT_SEPARATOR}korNm:string${UNIT_SEPARATOR}hgNm:string${UNIT_SEPARATOR}schregStGbn:string${UNIT_SEPARATOR}acqHp:string${UNIT_SEPARATOR}mrksAvg:string${UNIT_SEPARATOR}mrksCptnTmCnt:string${UNIT_SEPARATOR}colgNm:string`,
      `N${UNIT_SEPARATOR}202101234${UNIT_SEPARATOR}홍길동${UNIT_SEPARATOR}컴퓨터공학부${UNIT_SEPARATOR}10${UNIT_SEPARATOR}98${UNIT_SEPARATOR}3.85${UNIT_SEPARATOR}5${UNIT_SEPARATOR}정보기술대학`,
    ].join(RECORD_SEPARATOR);

    const result = parseAcademicBasicInfo(mockSsv);

    expect(result.studentId).toBe('202101234');
    expect(result.koreanName).toBe('홍길동');
    expect(result.departmentName).toBe('컴퓨터공학부');
    expect(result.enrollmentStatus).toBe('확인 불가');
    expect(result.acquiredCredits).toBe('98');
    expect(result.gradeAverage).toBe('3.85');
    expect(result.completedSemesterCount).toBe('5학기');
    expect(result.collegeName).toBe('정보기술대학');
  });

  it('ErrorCode가 0이 아니거나 세션 오류인 경우 예외를 발생시켜야 한다', () => {
    const errorSsv = 'ErrorCode:int=-1' + RECORD_SEPARATOR + 'ErrorMsg:String=Session expired';
    expect(() => parseAcademicBasicInfo(errorSsv)).toThrow('인천대 학사 시스템(ERP) 응답 오류');
  });
  it('ERP 코드표의 실제 명칭을 사용하고 코드값은 상세 화면에 노출하지 않는다', () => {
    const ssv = ['ErrorCode:int=0','Dataset:DS_SREG101', '_RowType_\u001fstuno\u001fkorNm\u001fhgCd\u001fschregStGbn', 'N\u001f202012345\u001f테스트\u001f0000077\u001f70'].join(RECORD_SEPARATOR);
    const commonCodes = ['ErrorCode:int=0','Dataset:DS_SCHREG_ST_GBN','_RowType_\u001fcode\u001fkorCdNm','N\u001f70\u001f수료'].join(RECORD_SEPARATOR);
    const result = parseAcademicBasicInfo(JSON.stringify({ssv, commonCodes, departments: {'0000077':'테스트학과'}}));
    expect(result.enrollmentStatus).toBe('수료');
    expect(result.departmentName).toBe('테스트학과');
    expect(JSON.stringify(result.displayFields)).not.toContain('0000077');
  });
});
