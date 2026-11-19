import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { act, render } from '@testing-library/react-native';
import { AcademicScraperManager, AcademicScraperWebView } from '../AcademicScraperWebView';

let webViewProps: any = null;

jest.mock('react-native-webview', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    WebView: ReactActual.forwardRef((props: any, _ref: any) => {
      webViewProps = props;
      return null;
    }),
  };
});

const creds = { studentId: '202600001', password: 'pw' };

const deliver = (msg: unknown) =>
  act(() => {
    webViewProps.onMessage({ nativeEvent: { data: JSON.stringify(msg) } });
  });

describe('AcademicScraperManager 요청 대체/마운트 대기', () => {
  let logSpy: any;
  let warnSpy: any;

  beforeEach(() => {
    jest.useFakeTimers();
    webViewProps = null;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('마운트 전에 같은 학번의 다른 액션으로 대체된 요청의 준비 타임아웃이 새 요청을 죽이지 않는다', async () => {
    const first = AcademicScraperManager.executeErpAction({ creds, actionId: 'ACTION_A' });
    const firstSettled = first.then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    const second = AcademicScraperManager.executeErpAction({ creds, actionId: 'ACTION_B' });
    let secondState: string | null = null;
    second.then(
      (v) => (secondState = `resolved:${v}`),
      (e: Error) => (secondState = `rejected:${e.message}`),
    );

    await expect(firstSettled).resolves.toContain('새로운 ERP 조회 요청');

    jest.advanceTimersByTime(1000);
    const view = render(React.createElement(AcademicScraperWebView));
    await act(async () => {});
    expect(webViewProps.source).toEqual({ uri: expect.stringContaining('portal.inu.ac.kr') });

    // 첫 요청의 마운트 대기 타임아웃(15초) 시점을 지나도 두 번째 요청은 살아 있어야 한다.
    await act(async () => {
      jest.advanceTimersByTime(15000);
    });
    expect(secondState).toBeNull();

    deliver({ type: 'ACADEMIC_RESULT', data: 'ok' });
    await act(async () => {});
    expect(secondState).toBe('resolved:ok');

    view.unmount();
  });

  it('같은 수험번호로 성명만 바꾼 신입생 재요청도 이전 요청의 타임아웃에 휘말리지 않는다', async () => {
    const freshman = (name: string) => ({
      creds: { studentId: '12345678', password: '' },
      actionId: 'FRESHMAN_ERP_AUTH',
      target: { params: { examNo: '12345678', name, birthDate: '20070101' } },
    });

    AcademicScraperManager.executeErpAction(freshman('홍길동')).catch(() => {});
    let secondState: string | null = null;
    AcademicScraperManager.executeErpAction(freshman('김길동')).then(
      () => (secondState = 'resolved'),
      (e: Error) => (secondState = `rejected:${e.message}`),
    );

    const view = render(React.createElement(AcademicScraperWebView));
    await act(async () => {});
    expect(webViewProps.source).toEqual({ uri: expect.stringContaining('erp.inu.ac.kr') });

    await act(async () => {
      jest.advanceTimersByTime(15000);
    });
    expect(secondState).toBeNull();

    // 35초 스크레이프 타임아웃은 여전히 동작한다.
    await act(async () => {
      jest.advanceTimersByTime(20000);
    });
    expect(secondState).toBe('rejected:포털 ERP 정보 조회 시간 초과 (35초)');

    view.unmount();
  });
});
