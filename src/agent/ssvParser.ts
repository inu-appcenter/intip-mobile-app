export interface AcademicBasicInfo {
  displayFields?: Record<string, string>;
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
  /** 사용자 본인 조회 화면용 ERP 원본 필드. 외부 AI 전달에는 사용하지 않는다. */
  rawFields: Record<string, string>;
}

const RECORD_SEPARATOR = String.fromCharCode(30);
const UNIT_SEPARATOR = String.fromCharCode(31);
const NULL_MARKER = String.fromCharCode(3);
const ROW_TYPE = '_RowType_';

function formatNexacroDate(raw?: string): string | undefined {
  if (!raw || raw.length !== 8) return raw;
  return `${raw.substring(0, 4)}-${raw.substring(4, 6)}-${raw.substring(6, 8)}`;
}

/** ERP 화면·학번에 따라 소속 학과 컬럼명이 달라진다. */
function firstValue(row: Record<string, string>, keys: string[]): string | undefined {
  return keys.map((key) => row[key]?.trim()).find(Boolean);
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
  let columnNames: string[] | null = null;
  let hasRowTypeColumn = false;

  for (let i = datasetIndex + 1; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('Dataset:')) {
      break;
    }

    if (
      record.startsWith('ErrorCode') ||
      record.startsWith('ErrorMsg') ||
      record.startsWith('_Const_') ||
      record.startsWith('ConstColumnInfo')
    ) {
      continue;
    }

    // 컬럼 정의 행: _RowType_ 또는 _Column_ 또는 ColumnInfo
    if (columnNames === null) {
      const parts = record.split(UNIT_SEPARATOR);
      const parsedCols: string[] = [];
      for (const part of parts) {
        if (!part) continue;
        const colName = part.split(':')[0];
        parsedCols.push(colName);
      }

      if (parsedCols.length > 0) {
        hasRowTypeColumn = parsedCols[0] === ROW_TYPE;
        columnNames = hasRowTypeColumn ? parsedCols.slice(1) : parsedCols;
        console.log(`[ssvParser] Dataset ${datasetName} columns:`, columnNames.slice(0, 10), `(total ${columnNames.length})`);
        continue;
      }
    }

    // 데이터 행 파싱
    if (!columnNames) continue;
    const tokens = record.split(UNIT_SEPARATOR);
    const startIndex = hasRowTypeColumn || tokens.length === columnNames.length + 1 ? 1 : 0;

    if (tokens.length >= columnNames.length + startIndex) {
      const row: Record<string, string> = {};
      row[ROW_TYPE] = tokens[0];

      for (let c = 0; c < columnNames.length; c++) {
        const rawVal = tokens[c + startIndex];
        if (rawVal === NULL_MARKER || rawVal === '' || rawVal === undefined) {
          row[columnNames[c]] = '';
        } else {
          row[columnNames[c]] = rawVal;
        }
      }
      rows.push(row);
    }
  }

  return rows;
}

export function parseAcademicBasicInfo(responseBody: string): AcademicBasicInfo {
  let commonCodes = '';
  let departments: Record<string, string> = {};
  if (responseBody.startsWith('{')) {
    const envelope = JSON.parse(responseBody);
    responseBody = envelope.ssv;
    commonCodes = envelope.commonCodes || '';
    departments = envelope.departments || {};
  }
  if (!responseBody || !responseBody.includes('ErrorCode:int=0')) {
    const preview = responseBody ? responseBody.substring(0, 200).replace(/[\r\n\x1e\x1f]/g, ' ') : 'EMPTY_RESPONSE';
    console.warn('[ssvParser] Invalid ERP response:', preview);
    throw new Error(`인천대 학사 시스템(ERP) 응답 오류 또는 세션 만료 (${preview})`);
  }

  const rows = parseRows(responseBody, 'DS_SREG101');
  if (rows.length === 0) {
    throw new Error('학적 정보(DS_SREG101) 데이터를 찾을 수 없습니다.');
  }

  const row = rows[0];
  const departmentName = firstValue(row, [
    'hgNm', 'deptNm', 'dptNm', 'sustNm', 'dpmjNm', 'dpmjKorNm', 'deptKorNm',
  ]);
  const departmentCode = firstValue(row, ['hgCd', 'deptCd', 'dptCd', 'sustCd', 'dpmjCd']);
  console.log('[ssvParser] Parsed row keys count:', Object.keys(row).length);
  console.log('[ssvParser] Sample values:', {
    stuno: row['stuno'],
    korNm: row['korNm'],
    acqHp: row['acqHp'],
    mrksAvg: row['mrksAvg'],
    schregStGbn: row['schregStGbn'],
    departmentName,
    departmentCandidates: Object.fromEntries(
      Object.entries(row).filter(([key, value]) => /(?:hg|dept|dpt|sust|dpmj).*?(?:nm|cd)/i.test(key) && value),
    ),
  });

  // 학적 상태 한글 매핑 기본값
  let status = row['schregStGbn'] || '재학';
  if (status === '10' || status === '1') status = '재학';
  else if (status === '20' || status === '2') status = '휴학';
  else if (status === '30' || status === '3') status = '졸업';
  else if (status === '70') status = '정상';

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
    departmentCode,
    departmentName: departmentName || '학과 미지정',
    majorCode: row['hgMjCd'],
    majorName: row['mjNm'],
    collegeName: row['colgNm'],
    completedSemesterCode: row['cnpassHySeqGbn'],
    completedSemesterName: row['cptnTmNm'],
    completedSemesterCount: row['mrksCptnTmCnt'] ? `${row['mrksCptnTmCnt']}학기` : '',
    acquiredCredits: row['acqHp'] || '0',
    gradeAverage: row['mrksAvg'] || '0.0',
    advisorProfessorName: row['profNm'],
    rawFields: Object.fromEntries(Object.entries(row).filter(([key]) => !['_RowType_', '_Column_', 'phtFile1', 'phtFile2'].includes(key))),
    ...enrichAcademicRow(row, commonCodes, departments),
  };
}

function enrichAcademicRow(row: Record<string, string>, codes: string, departments: Record<string, string>) {
  const displayFields: Record<string, string> = {};
  const fields: Record<string, string> = {};
  const mappings = [
    ['schregStGbn','DS_SCHREG_ST_GBN','enrollmentStatus','학적 상태'],
    ['entrClsfGbn','DS_ENTR_CLSF_GBN','entranceClassification','입학 구분'],
    ['entrGbn','DS_ENTR_GBN','entranceType','입학 전형'],
    ['flSchregModGbn','DS_SCHREG_MOD_GBN','latestEnrollmentChange','최근 학적 변동'],
    ['genGbn','DS_GEN_GBN','gender','성별'],
    ['corsGbn','DS_CORS_GBN','courseName','과정'],
    ['hySeqGbn','DS_HY_SEQ_GBN','semesterSequenceName','학기'],
    ['natGbn','DS_NAT_GBN','nationalityName','국적'],
    ['milFinishGbn','DS_MIL_FINISH_GBN','militaryStatusName','병역 상태'],
    ['capaIoGbn','DS_CAPA_IO_GBN','capacityIoName','정원 내외 구분'],
    ['skilStdGbn','DS_SKIL_STD_GBN','skillStandardName','특기 기준'],
  ];
  for (const [column, dataset, field, label] of mappings) {
    let name = '';
    try {
      const item = parseRows(codes, dataset).find(item => item.code?.trim() === row[column]?.trim());
      if (item) name = firstValue(item, ['fullNm','korCdNm','codeNm']) || '';
    } catch { /* Keep basic data when enrichment is unavailable. */ }
    fields[field] = name || '확인 불가';
    displayFields[label] = fields[field];
  }
  for (const [column, sourceName, field, label] of [
    ['hgCd','hgNm','departmentName','학과'], ['hgMjCd','mjNm','majorName','전공'],
    ['colgGrscCd','','collegeGroupName','대학 구분'], ['colgCd','colgNm','collegeName','단과대'],
  ]) {
    fields[field] = row[sourceName]?.trim() || departments[row[column]?.trim()] || '확인 불가';
    displayFields[label] = fields[field];
  }
  for (const [column,label] of [['engNm','영문명'],['entrDt','입학일'],['flSchregModDt','학적 변동일'],['birthDt','생년월일'],['cptnTmNm','이수 학기명'],['handpNo','휴대전화']]) {
    if (row[column]) displayFields[label] = column.endsWith('Dt') ? formatNexacroDate(row[column]) || '' : row[column].trim();
  }
  if (row.rrn) displayFields['주민등록번호(마스킹)'] = '******-*******';
  for (const [column,label] of [['readmiYn','재입학 여부'],['earlyGrdtYn','조기졸업 여부'],['grdtExpcYn','졸업예정 여부'],['bcrmstConnYn','학석사 연계 여부']]) {
    displayFields[label] = ['1','Y'].includes(row[column]) ? '예' : ['0','N'].includes(row[column]) ? '아니오' : '확인 불가';
  }
  return {...fields, displayFields};
}
