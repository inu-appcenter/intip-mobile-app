/**
 * The two pure pieces of `withWidgetAssets`.
 *
 * `toResourceName` is worth pinning because its counterpart lives in another
 * repo — expo-widgets-glance's `AssetDrawables.toResourceName` — and a
 * disagreement between them is invisible on iOS and shows up on Android only
 * as a placeholder glyph at runtime.
 *
 * `parseMonochromeSvg` is worth pinning because its whole job is to refuse
 * anything it cannot convert faithfully, and a guard that silently stops
 * guarding is worse than no guard.
 */
import { describe, it, expect } from '@jest/globals';

// The plugin is CommonJS (like every other file in `plugins/`), so it comes in
// through `require` rather than an import.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { toResourceName, parseMonochromeSvg } = require('../withWidgetAssets') as {
  toResourceName: (assetName: string) => string;
  parseMonochromeSvg: (
    svg: string,
    sourcePath: string,
  ) => { pathData: string; viewportWidth: number; viewportHeight: number };
};

const MONOCHROME_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">\n' +
  '<path d="M17 4C20.4 4 23 7.64 23 12Z" fill="#0E4D9D"/>\n' +
  '</svg>\n';

describe('toResourceName', () => {
  it('converts asset catalog PascalCase to an Android resource name', () => {
    expect(toResourceName('BusIcon')).toBe('bus_icon');
  });

  it('splits a run of capitals before the last one, not between every pair', () => {
    expect(toResourceName('SFBusIcon')).toBe('sf_bus_icon');
  });

  it('leaves an already-valid resource name alone', () => {
    expect(toResourceName('bus_icon')).toBe('bus_icon');
  });

  it('replaces characters Android resource names cannot contain', () => {
    expect(toResourceName('Bus-Icon.2')).toBe('bus_icon_2');
  });
});

describe('parseMonochromeSvg', () => {
  it('extracts the path data and viewBox dimensions', () => {
    expect(parseMonochromeSvg(MONOCHROME_SVG, 'busIcon.svg')).toEqual({
      pathData: 'M17 4C20.4 4 23 7.64 23 12Z',
      viewportWidth: 24,
      viewportHeight: 24,
    });
  });

  it.each([
    ['a group', MONOCHROME_SVG.replace('<path', '<g><path')],
    ['a gradient', MONOCHROME_SVG.replace('fill="#0E4D9D"', 'fill="url(#linearGradient)"')],
    ['a stroke', MONOCHROME_SVG.replace('fill="#0E4D9D"', 'stroke="#000"')],
    ['a transform', MONOCHROME_SVG.replace('<path', '<path transform="translate(1)"')],
    ['two paths', MONOCHROME_SVG.replace('</svg>', '<path d="M0 0Z"/></svg>')],
    ['no viewBox', MONOCHROME_SVG.replace(' viewBox="0 0 24 24"', '')],
  ])('refuses an SVG with %s rather than converting it', (_label: string, svg: string) => {
    expect(() => parseMonochromeSvg(svg, 'busIcon.svg')).toThrow(/withWidgetAssets/);
  });
});
