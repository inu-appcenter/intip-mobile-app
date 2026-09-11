import type { ReactNode } from 'react';

import { Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  border,
  containerBackground,
  font,
  foregroundStyle,
  frame,
  multilineTextAlignment,
  padding,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import { registerGlanceWidget } from 'expo-widgets-glance';

/**
 * One line of a class: what it's called and where (or how) it happens.
 * `location` also carries the design's "온라인 수업" case — a class held
 * online has no room, so the string just says so instead of a room number.
 */
type ClassInfo = {
  className: string;
  location: string;
};

/**
 * Every state the small "다음 수업" (next class) widget can render. Naming
 * mirrors the Figma frames (Widgets/다음 수업/*) so a state here maps back to
 * a design 1:1:
 *
 * - `upcoming`   → "수업 전" / "온라인 수업" (same layout, `location` differs)
 * - `ongoing`    → "수업 중"
 * - `doneForToday` → "오늘 수업 종료"
 * - `dayOff`     → "공강"
 * - `loggedOut`  → "미로그인"
 * - `noTimetable` → "시간표 없음"
 * - `stale`      → "캐시 7일 초과" (last-known snapshot too old to trust)
 *
 * Real data fetching is not wired up yet — the widget is only fed
 * `DEFAULT_PROPS` below (see `src/widgets/refresh.ts` once it exists for this
 * widget). Building the state machine here first means the snapshot-pushing
 * side has a concrete shape to target later.
 */
export type NextClassWidgetProps =
  | ({ status: 'upcoming'; timeRange: string } & ClassInfo)
  | ({ status: 'ongoing'; endsAtLabel: string } & ClassInfo)
  | { status: 'doneForToday'; nextClassLabel: string }
  | { status: 'dayOff' }
  | { status: 'loggedOut' }
  | { status: 'noTimetable' }
  | { status: 'stale' };

/** Sample "수업 전" snapshot, matching the default Figma frame. */
export const DEFAULT_PROPS: NextClassWidgetProps = {
  status: 'upcoming',
  className: '자료구조',
  timeRange: '11:00–12:15',
  location: '7호관 305',
};

/**
 * Home screen widget for the next (or current) class.
 *
 * See the `'widget'` directive note in `TestWidget.tsx` — this function is
 * extracted into the separate widget JS bundle, so it can only see
 * `@expo/ui/swift-ui` globals and whatever is declared inside its own body;
 * every color/style constant is therefore local to `render`, not
 * module-scope.
 *
 * Only `systemSmall` is designed today (all 8 Figma frames are the small
 * size), so `environment.widgetFamily` isn't branched on.
 */
const NextClassWidget = (props: NextClassWidgetProps, environment: WidgetEnvironment) => {
  'widget';

  const isDark = environment.colorScheme === 'dark';

  // The Figma frames only spec light mode. Dark values below extend the same
  // semantic tokens (text/primary, text/tertiary, text/brand, bg/brand,
  // border/brand-subtle) using the same light/dark pairing TestWidget.tsx
  // already established for this widget bundle — re-measure against a real
  // dark-mode design if one ever ships.
  const colors = isDark
    ? {
        cardBg: '#1C1C1E',
        brandCardBg: '#13223A',
        brandBorder: '#28405F',
        textPrimary: '#FFFFFF',
        textTertiary: '#98989F',
        textBrand: '#4C8DFF',
      }
    : {
        cardBg: '#FFFFFF',
        brandCardBg: '#EFF6FF',
        brandBorder: '#D3E5FF',
        textPrimary: '#191F28',
        textTertiary: '#8B95A1',
        textBrand: '#0061FF',
      };

  const label = (text: string) => (
    <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(colors.textTertiary)]}>
      {text}
    </Text>
  );

  // Takes one or more lines rather than an embedded newline escape sequence:
  // Function.toString(), what carries this function source to the widget
  // process (see the module doc comment above), does not reliably round-trip
  // a backslash-n escape inside a string literal on Hermes — it comes back
  // as a literal raw newline byte, which breaks re-parsing a single-quoted
  // string. Confirmed against a real Android build: an Invalid-or-unexpected
  // token error, splitting the dayOff heading text apart mid-string.
  // Separate Text lines sidesteps the escape entirely and matches the Figma
  // source anyway, which used two separate paragraph tags there too.
  //
  // NOTE for future edits to comments in this function: never spell out the
  // literal two-character escape sequence backslash-n anywhere in here, even
  // inside a comment describing it (as an earlier version of this very
  // comment did, self-inflicting the exact bug above). Whatever step in the
  // Metro/Hermes pipeline corrupts that sequence into a real newline byte
  // inside string literals does the same thing inside "//" comment text —
  // splitting one comment line into two, with the second half landing as
  // live, broken code. If you need to reference the sequence, spell it out
  // in words the way this note does.
  const heading = (...lines: string[]) => (
    <VStack alignment="leading" spacing={0}>
      {lines.map((line, index) => (
        <Text
          key={index}
          modifiers={[
            font({ size: 20, weight: 'semibold' }),
            foregroundStyle(colors.textPrimary),
            multilineTextAlignment('leading'),
          ]}
        >
          {line}
        </Text>
      ))}
    </VStack>
  );

  const caption = (text: string) => (
    <Text modifiers={[font({ size: 12, weight: 'regular' }), foregroundStyle(colors.textTertiary)]}>
      {text}
    </Text>
  );

  const classDetail = (primary: string, secondary: string) => (
    <VStack alignment="leading" spacing={0}>
      <Text
        modifiers={[font({ size: 14, weight: 'semibold' }), foregroundStyle(colors.textBrand)]}
      >
        {primary}
      </Text>
      <Text modifiers={[font({ size: 14, weight: 'regular' }), foregroundStyle(colors.textTertiary)]}>
        {secondary}
      </Text>
    </VStack>
  );

  let content: ReactNode;
  let background = colors.cardBg;
  let borderColor: string | null = null;

  switch (props.status) {
    case 'upcoming':
      content = (
        <>
          {label('다음 수업')}
          {heading(props.className)}
          {classDetail(props.timeRange, props.location)}
        </>
      );
      break;
    case 'ongoing':
      background = colors.brandCardBg;
      borderColor = colors.brandBorder;
      content = (
        <>
          <Text
            modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(colors.textBrand)]}
          >
            수업 중
          </Text>
          {heading(props.className)}
          {classDetail(props.endsAtLabel, props.location)}
        </>
      );
      break;
    case 'doneForToday':
      content = (
        <>
          {label('다음 수업')}
          {heading('오늘 수업 끝!')}
          {caption(props.nextClassLabel)}
        </>
      );
      break;
    case 'dayOff':
      content = (
        <>
          {heading('오늘은', '공강이에요')}
          {caption('푹 쉬세요')}
        </>
      );
      break;
    case 'loggedOut':
      content = (
        <>
          {label('다음 수업')}
          {heading('로그인하고', '시작하기')}
        </>
      );
      break;
    case 'noTimetable':
      content = (
        <>
          {label('다음 수업')}
          {heading('시간표를', '만들어 보세요')}
        </>
      );
      break;
    case 'stale':
      content = (
        <>
          {heading('정보를 불러오지', '못했어요')}
          {caption('앱에서 확인해 주세요')}
        </>
      );
      break;
  }

  // "공강" is the only state centered by the design (justify-center in the
  // Figma export); every other state stacks from the top. `frame` gives the
  // stack the widget's full height so the two Spacers below have room to
  // actually push `content` to the middle instead of collapsing to nothing.
  const centered = props.status === 'dayOff';

  return (
    <VStack
      alignment="leading"
      spacing={8}
      modifiers={[
        padding({ top: 20, bottom: 16, leading: 16, trailing: 16 }),
        containerBackground(background, 'widget'),
        ...(borderColor ? [border({ color: borderColor, width: 1 })] : []),
        frame({ maxHeight: Infinity }),
        // Tapping anywhere on the widget opens the app.
        widgetURL('intipmobileapp://'),
      ]}
    >
      {centered && <Spacer />}
      {content}
      {centered && <Spacer />}
    </VStack>
  );
};

// Android has no equivalent of createWidget()'s implicit iOS layout capture
// (see expo-widgets-glance's README) — this explicit call is what stands in
// for it. No-op on iOS.
registerGlanceWidget('NextClassWidget', NextClassWidget);

export default createWidget('NextClassWidget', NextClassWidget);
