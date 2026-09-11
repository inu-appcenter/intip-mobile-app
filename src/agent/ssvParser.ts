export interface AcademicBasicInfo {
  studentId: string;
  koreanName: string;
  englishName?: string;
  enrollmentStatus: string;
  entranceClassification?: string;
  entranceType?: string;
  entranceDate?: string;
  latestEnrollmentChange?: string;
  latestEnrollmentChangeDate?: string;
  gender?: string;
  birthDate?: string;
  departmentCode?: string;
  departmentName: string;
  majorCode?: string;
  majorName?: string;
  collegeName?: string;
  completedSemesterCode?: string;
  completedSemesterName?: string;
  completedSemesterCount?: string;
  acquiredCredits: string;
  gradeAverage: string;
  advisorProfessorName?: string;
}

const RECORD_SEPARATOR = String.fromCharCode(30);
const UNIT_SEPARATOR = String.fromCharCode(31);
const NULL_MARKER = String.fromCharCode(3);
const ROW_TYPE = '_RowType_';

function formatNexacroDate(raw?: string): string | undefined {
  if (!raw || raw.length !== 8) return raw;
  return `${raw.substring(0, 4)}-${raw.substring(4, 6)}-${raw.substring(6, 8)}`;
}

export function parseRows(responseBody: string, datasetName: string): Record<string, string>[] {
  const records = responseBody.split(RECORD_SEPARATOR);
  let datasetIndex = -1;

  for (let i = 0; i < records.length; i++) {
    if (records[i] === `Dataset:${datasetName}`) {
      datasetIndex = i;
      break;
    }
  }

  if (datasetIndex < 0) {
    throw new Error(`Dataset '${datasetName}' not found in SSV response.`);
  }

  const rows: Record<string, string>[] = [];
  const columnNames: string[] = [];

  for (let i = datasetIndex + 1; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith('Dataset:')) {
      break;
    }

    if (record.startsWith('_Const_')) {
      continue;
    }

    if (record.startsWith('_Column_')) {
      const parts = record.split(UNIT_SEPARATOR);
      for (const part of parts) {
        if (!part || part === '_Column_') continue;
        const colDef = part.split(':');
        if (colDef.length > 0 && colDef[0]) {
          columnNames.push(colDef[0]);
        }
      }
      continue;
    }

    if (record.startsWith('N') || record.startsWith('U') || record.startsWith('I') || record.startsWith('D')) {
      const units = record.split(UNIT_SEPARATOR);
      const row: Record<string, string> = {};

      row[ROW_TYPE] = units[0];

      let unitIndex = 1;
      for (const colName of columnNames) {
        if (unitIndex < units.length) {
          const rawVal = units[unitIndex];
          if (rawVal === NULL_MARKER || rawVal === '') {
            row[colName] = '';
          } else {
            row[colName] = rawVal;
          }
          unitIndex++;
        }
      }
      rows.push(row);
    }
  }

  return rows;
}

export function parseAcademicBasicInfo(responseBody: string): AcademicBasicInfo {
  if (!responseBody || !responseBody.includes('ErrorCode:int=0')) {
    throw new Error('인천대 학사 시스템(ERP) 응답 오류 또는 세션 만료');
  }

  const rows = parseRows(responseBody, 'DS_SREG101');
  if (rows.length === 0) {
    throw new Error('학적 정보(DS_SREG101) 데이터를 찾을 수 없습니다.');
  }

  const row = rows[0];

  // 학적 상태 한글 매핑 기본값
  let status = row['schregStGbn'] || '재학';
  if (status === '10' || status === '1') status = '재학';
  else if (status === '20' || status === '2') status = '휴학';
  else if (status === '30' || status === '3') status = '졸업';

  return {
    studentId: row['stuno'] || '',
    koreanName: row['korNm'] || '',
    englishName: row['engNm'] || '',
    enrollmentStatus: status,
    entranceClassification: row['entrClsfGbn'],
    entranceType: row['entrGbn'],
    entranceDate: formatNexacroDate(row['entrDt']),
    latestEnrollmentChange: row['flSchregModGbn'],
    latestEnrollmentChangeDate: formatNexacroDate(row['flSchregModDt']),
    gender: row['genGbn'] === '1' ? '남' : row['genGbn'] === '2' ? '여' : row['genGbn'],
    birthDate: formatNexacroDate(row['birthDt']),
    departmentCode: row['hgCd'],
    departmentName: row['hgNm'] || '학과 미지정',
    majorCode: row['hgMjCd'],
    majorName: row['mjNm'],
    collegeName: row['colgNm'],
    completedSemesterCode: row['cnpassHySeqGbn'],
    completedSemesterName: row['cptnTmNm'],
    completedSemesterCount: row['mrksCptnTmCnt'] ? `${row['mrksCptnTmCnt']}학기` : '',
    acquiredCredits: row['acqHp'] || '0',
    gradeAverage: row['mrksAvg'] || '0.0',
    advisorProfessorName: row['profNm'],
  };
}
