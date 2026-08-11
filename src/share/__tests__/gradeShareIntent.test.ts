import { describe, it, expect } from '@jest/globals';
import { portalUrlFor } from '../../webview/constants';
import { resolveGradeShareIntent } from '../gradeShareIntent';
import type { NavIntent } from '../../push/navIntent';

/** Every intent this module produces is the "push" variant — narrow for the assertions below. */
function asPush(intent: NavIntent | null) {
  if (intent?.kind !== 'push') throw new Error(`expected a "push" intent, got ${JSON.stringify(intent)}`);
  return intent;
}

describe('resolveGradeShareIntent', () => {
  it('returns null when there is no text', () => {
    expect(resolveGradeShareIntent({})).toBeNull();
    expect(resolveGradeShareIntent({ text: null })).toBeNull();
    expect(resolveGradeShareIntent({ text: undefined })).toBeNull();
  });

  it('returns null for blank/whitespace-only text', () => {
    expect(resolveGradeShareIntent({ text: '   \n\t  ' })).toBeNull();
  });

  it('builds a "push" intent at the calculator path with the text URL-encoded', () => {
    const text = '운영체제 / IAA6018\t3\tB+\t전공핵심\t전공핵심';
    const result = resolveGradeShareIntent({ text });
    expect(result).toEqual({
      kind: 'push',
      path: `/timetable/calculator?sharedGrades=${encodeURIComponent(text)}`,
      url: portalUrlFor(`/timetable/calculator?sharedGrades=${encodeURIComponent(text)}`),
    });
  });

  it('trims leading/trailing whitespace around the shared text', () => {
    const result = asPush(resolveGradeShareIntent({ text: '  기업가정신 / 0005103\t1\tP  \n' }));
    expect(result.path).toBe(
      `/timetable/calculator?sharedGrades=${encodeURIComponent('기업가정신 / 0005103\t1\tP')}`,
    );
  });

  it('truncates pathologically long shared text instead of forwarding it verbatim', () => {
    const huge = 'a'.repeat(50_000);
    const result = asPush(resolveGradeShareIntent({ text: huge }));
    const decoded = decodeURIComponent(new URL(result.url).search.slice('?sharedGrades='.length));
    expect(decoded.length).toBe(20_000);
  });

  it('produces a fully-qualified portal url usable by a native sub-page push', () => {
    const result = asPush(resolveGradeShareIntent({ text: 'A / 1' }));
    expect(result.url.startsWith('https://')).toBe(true);
    expect(result.url).toContain('/timetable/calculator');
  });
});
