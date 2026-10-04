/**
 * The injected scripts are concatenated into one `injectedJavaScript` batch, so
 * a single syntax error silently disables every one of them. Parse what the
 * WebView actually receives.
 */
import { describe, expect, it } from '@jest/globals';
import {
  INJECTED_SCRIPT,
  buildEdgeGuardBandScript,
  buildEdgeGuardDiagnosticsScript,
  buildEdgeLongPressGuardScript,
} from '../injectedScript';

describe('edge guard script', () => {
  it.each([true, false])('parses with preventDefault=%s', (preventDefault) => {
    const batch =
      INJECTED_SCRIPT +
      buildEdgeLongPressGuardScript(29.87, 29.87, preventDefault) +
      buildEdgeGuardDiagnosticsScript();
    expect(() => new Function(batch)).not.toThrow();
  });

  it('bakes the preventDefault mode into the guard state', () => {
    expect(buildEdgeLongPressGuardScript(30, 30, false)).toContain('preventDefault: false,');
    expect(buildEdgeLongPressGuardScript(30, 30, true)).toContain('preventDefault: true,');
  });

  it('parses the live band update', () => {
    expect(() => new Function(buildEdgeGuardBandScript(24, 0))).not.toThrow();
  });
});
