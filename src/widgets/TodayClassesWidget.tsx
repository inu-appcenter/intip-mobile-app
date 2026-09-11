import { HStack, Rectangle, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  background,
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

/** One row of the day's schedule list. */
type ScheduleRow = {
  timeRange: string;
  className: string;
  room: string;
  /** The current or next class — gets the tinted row + brand-colored time. */
  highlighted?: boolean;
};

/**
 * States for the medium "오늘 수업" (today's classes) widget, named after the
 * Figma frames (Widgets/오늘 수업/*):
 *
 * - `normal`      → "정상": today's schedule, up to 3 rows
 * - `dayOff`      → "공강"
 * - `noTimetable` → "시간표 미등록"
 *
 * Real data fetching isn't wired up yet — see `DEFAULT_PROPS` and
 * `src/widgets/refresh.ts`. This shape is what a future timetable fetch
 * should resolve to.
 */
export type TodayClassesWidgetProps =
  | { status: 'normal'; dateLabel: string; notice: string; rows: ScheduleRow[] }
  | { status: 'dayOff'; dateLabel: string }
  | { status: 'noTimetable'; dateLabel: string };

/** Sample "정상" snapshot, matching the default Figma frame. */
export const DEFAULT_PROPS: TodayClassesWidgetProps = {
  status: 'normal',
  dateLabel: '9월 1일 화요일',
  notice: '1시간 후 시작',
  rows: [
    { timeRange: '09:00~10:15', className: '자료구조', room: '07-504', highlighted: true },
    { timeRange: '16:30~17:45', className: '디지털공학', room: '07-504' },
    { timeRange: '16:30~17:45', className: '인공지능개론', room: '07-308' },
  ],
};

/**
 * Home screen widget listing today's classes.
 *
 * See the `'widget'` directive note in `TestWidget.tsx` — this function runs
 * in the separate widget JS bundle, so every color/style constant below is
 * declared inside `render`, not at module scope.
 *
 * Only `systemMedium` is designed today (all 3 Figma frames are the medium
 * size), so `environment.widgetFamily` isn't branched on.
 */
const TodayClassesWidget = (props: TodayClassesWidgetProps, environment: WidgetEnvironment) => {
  'widget';

  // The list only has room for 3 rows at the medium widget's fixed height.
  // Declared here, not at module scope: see the doc comment above — only
  // this function's own source text ships to the widget process, so a
  // module-scope constant referenced from inside it resolves to nothing
  // there ("'MAX_ROWS' is not defined", caught the hard way against a real
  // Android build before this comment existed).
  const MAX_ROWS = 3;

  const isDark = environment.colorScheme === 'dark';

  // The Figma frames only spec light mode; dark values extend the same
  // semantic tokens (text/secondary, text/tertiary, text/disabled, bg/brand)
  // using the same light/dark pairing TestWidget.tsx already established for
  // this widget bundle — re-measure against a real dark-mode design if one
  // ever ships.
  const colors = isDark
    ? {
        cardBg: '#1C1C1E',
        rowHighlightBg: '#13223A',
        textSecondary: '#E5E5EA',
        textTertiary: '#98989F',
        textDisabled: '#6B6B70',
        textBrand: '#4C8DFF',
      }
    : {
        cardBg: '#FFFFFF',
        rowHighlightBg: '#EFF6FF',
        textSecondary: '#333D4B',
        textTertiary: '#8B95A1',
        textDisabled: '#B0B8C1',
        textBrand: '#0061FF',
      };

  const dateLabel = (text: string) => (
    <Text modifiers={[font({ size: 14, weight: 'medium' }), foregroundStyle(colors.textTertiary)]}>
      {text}
    </Text>
  );

  // Android/Glance note — a real, confirmed platform constraint, not an
  // implementation gap: there's no way on this renderer for the accent bar
  // to *fill* the row's actual height and only that. Two approaches were
  // tried and both failed the same way for the same underlying reason —
  // Glance's AppWidget/RemoteViews translation doesn't do free-form,
  // deferred measurement (unlike real Compose UI); it picks from a fixed
  // set of pre-built layout templates, and asking any descendant to
  // `fillMaxHeight()` reliably makes that request bubble up and inflate
  // *every* ancestor container along with it, all the way to the row's own
  // slot in the outer schedule list:
  //   1. Bar as a plain HStack sibling with `frame({maxHeight: Infinity})`
  //      — the row itself ballooned to swallow all the vertical space in
  //      its parent VStack, hiding the two rows after it.
  //   2. Bar and content both inside a ZStack/Box instead (Box normally
  //      sizes itself to its largest child and lets others independently
  //      fill to match — the standard FrameLayout pattern) — same result,
  //      confirmed on a real render: RemoteViews doesn't get that
  //      indirection either.
  // ROW_HEIGHT_DP below is the fallback: a fixed height, measured off an
  // actual render of this row (padding 4/4 + a 16sp semibold line ≈ 31dp),
  // not a computed one. It'll drift if the row's font size/padding ever
  // changes — there's no live alternative to keep it honest short of a
  // native measurement pass this renderer doesn't have.
  const ROW_HEIGHT_DP = 31;

  const row = (item: ScheduleRow, key: number) => (
    // Two nesting tiers: the OUTER row is the row's true edge — unpadded,
    // so the accent bar sits flush against it (border-box), while the INNER
    // row owns the 8/4 padding around the actual content (content-box).
    <HStack
      key={key}
      spacing={0}
      alignment="center"
      modifiers={[
        frame({ maxWidth: Infinity }),
        // Figma has no border-radius on this row — a plain fill (matching
        // the design's flat left-border-plus-tint treatment), not rounded.
        ...(item.highlighted ? [background(colors.rowHighlightBg)] : []),
      ]}
    >
      {item.highlighted && (
        <Rectangle modifiers={[frame({ width: 2, height: ROW_HEIGHT_DP }), background(colors.textBrand)]} />
      )}
      <HStack
        spacing={4}
        alignment="center"
        modifiers={[frame({ maxWidth: Infinity }), padding({ horizontal: 8, vertical: 4 })]}
      >
        {/* Glance/Android note: this inner row needs its own width for the
            same reason the outer one does — the nested time/name row below
            asking to fill remaining width inside a wrap_content parent is
            undefined on RemoteViews (SwiftUI resolves it fine). See git
            history for the isolation steps that pinned this down. */}
        <HStack spacing={0} alignment="center" modifiers={[frame({ maxWidth: Infinity })]}>
          <Text
            modifiers={[
              font({ size: 12, weight: 'medium' }),
              foregroundStyle(item.highlighted ? colors.textBrand : colors.textTertiary),
              frame({ width: 76 }),
            ]}
          >
            {item.timeRange}
          </Text>
          <Text
            modifiers={[
              font({ size: 16, weight: 'semibold' }),
              foregroundStyle(colors.textSecondary),
              frame({ maxWidth: Infinity, alignment: 'leading' }),
            ]}
          >
            {item.className}
          </Text>
        </HStack>
        <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(colors.textTertiary)]}>
          {item.room}
        </Text>
      </HStack>
    </HStack>
  );

  let content;
  switch (props.status) {
    case 'normal':
      content = (
        <>
          <HStack alignment="center" modifiers={[frame({ maxWidth: Infinity })]}>
            {dateLabel(props.dateLabel)}
            <Spacer />
            <Text
              modifiers={[font({ size: 14, weight: 'semibold' }), foregroundStyle(colors.textBrand)]}
            >
              {props.notice}
            </Text>
          </HStack>
          <VStack alignment="leading" spacing={4} modifiers={[frame({ maxWidth: Infinity })]}>
            {props.rows.slice(0, MAX_ROWS).map((item, index) => row(item, index))}
          </VStack>
        </>
      );
      break;
    case 'dayOff':
      content = (
        <>
          <Spacer />
          {dateLabel(props.dateLabel)}
          <Text
            modifiers={[font({ size: 20, weight: 'semibold' }), foregroundStyle(colors.textSecondary)]}
          >
            오늘은 공강이에요
          </Text>
          <Spacer />
        </>
      );
      break;
    case 'noTimetable':
      content = (
        <>
          {dateLabel(props.dateLabel)}
          <Spacer />
          <Text
            modifiers={[
              font({ size: 12, weight: 'regular' }),
              foregroundStyle(colors.textDisabled),
              multilineTextAlignment('center'),
              frame({ maxWidth: Infinity, alignment: 'center' }),
            ]}
          >
            등록된 시간표가 없어요. 시간표를 만들어 보세요.
          </Text>
          <Spacer />
        </>
      );
      break;
  }

  return (
    <VStack
      alignment="leading"
      spacing={12}
      modifiers={[
        padding({ top: 20, bottom: 16, leading: 16, trailing: 16 }),
        containerBackground(colors.cardBg, 'widget'),
        frame({ maxHeight: Infinity }),
        // Tapping anywhere on the widget opens the app.
        widgetURL('intipmobileapp://'),
      ]}
    >
      {content}
    </VStack>
  );
};

// See the identical call in NextClassWidget.tsx for why this exists.
registerGlanceWidget('TodayClassesWidget', TodayClassesWidget);

export default createWidget('TodayClassesWidget', TodayClassesWidget);
