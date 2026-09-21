import type { ReactNode } from 'react';

import { HStack, Rectangle, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  background,
  containerBackground,
  cornerRadius,
  font,
  foregroundStyle,
  frame,
  padding,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import { registerGlanceWidget } from 'expo-widgets-glance';

/** One class block: when it happens (minutes since the grid's first hour), how long, and the pastel color Figma assigns it. */
type ClassBlock = {
  startMinutes: number;
  durationMinutes: number;
  className: string;
  room: string;
  /** One of the Figma "timetable-color/*" tokens, as a hex value. */
  color: string;
};

/**
 * States for the large "시간표" (timetable) widget, now the real Mon–Fri
 * week grid from the Figma frame (5297:16605) instead of the single-day
 * list this file used to fall back to.
 *
 * That fallback existed because the Figma frame positions each class by an
 * absolute pixel offset against a time axis, and neither `@expo/ui/swift-ui`'s
 * widget-safe subset nor expo-widgets-glance's Glance renderer has anything
 * resembling "place this box at this exact (x, y)" — confirmed genuinely
 * absent on the Android side (no `Modifier.offset()` equivalent exists in
 * Jetpack Glance's public API at all, checked directly against the resolved
 * jar). The grid below reproduces the same visual result without needing
 * that primitive: a day's classes are laid out as an ordinary `VStack` of
 * alternating `Spacer`s (sized to the gap before each class) and class
 * blocks (sized to their duration) — relative stacking that computes to the
 * same positions absolute placement would have produced, using only
 * `frame`'s fixed width/height, which every widget renderer here already
 * supports. See `expo-widgets-glance`'s `examples/TimeGridWidget.tsx` for
 * this same technique written up as a standalone, reusable pattern.
 */
export type TimetableWidgetProps =
  | { status: 'normal'; classesByDay: ClassBlock[][]; todayIndex?: number }
  | { status: 'dayOff' }
  | { status: 'noTimetable' };

/** Sample snapshot — Mon–Fri, loosely matching the Figma frame's own sample classes and colors. */
export const DEFAULT_PROPS: TimetableWidgetProps = {
  status: 'normal',
  todayIndex: 0,
  classesByDay: [
    [
      { startMinutes: 60, durationMinutes: 75, className: 'Academic English', room: '12-402', color: '#FFA6A6' },
      { startMinutes: 300, durationMinutes: 50, className: '자기설계세미나', room: '12-402', color: '#FFE589' },
      { startMinutes: 420, durationMinutes: 60, className: '프로그래밍입문', room: '07-407', color: '#79DDDF' },
    ],
    [
      { startMinutes: 60, durationMinutes: 75, className: '소셜커뮤니케이션', room: '12-404', color: '#94CDFA' },
      { startMinutes: 180, durationMinutes: 90, className: '대학수학 (1)', room: '07-407', color: '#ACBCFD' },
    ],
    [
      { startMinutes: 90, durationMinutes: 60, className: '프로그래밍입문', room: '07-408', color: '#79DDDF' },
      { startMinutes: 180, durationMinutes: 60, className: '컴퓨터공학개론', room: '07-407', color: '#FFCB94' },
    ],
    [{ startMinutes: 60, durationMinutes: 75, className: '소셜커뮤니케이션', room: '12-404', color: '#94CDFA' }],
    [{ startMinutes: 240, durationMinutes: 120, className: '창의적사고와문제해결', room: '12-304', color: '#C1ACFC' }],
  ],
};

/**
 * Home screen widget for the week's timetable.
 *
 * See the `'widget'` directive note in `TestWidget.tsx` — only this
 * function's own source and whatever it declares internally ships to the
 * widget process. Every helper below (`minutesToHeight`, `dayColumn`, ...)
 * is declared inside this function body for exactly that reason — a
 * separate imported helper module would compile fine but resolve to nothing
 * at render time, since only this function's own source text is what
 * actually ships.
 *
 * Only `systemLarge` is designed today (the one Figma frame), so
 * `environment.widgetFamily` isn't branched on.
 */
const TimetableWidget = (props: TimetableWidgetProps, environment: WidgetEnvironment) => {
  'widget';

  const isDark = environment.colorScheme === 'dark';

  const WEEKDAY_LABELS = ['월', '화', '수', '목', '금'];

  const colors = isDark
    ? {
        cardBg: '#1C1C1E',
        textPrimary: '#FFFFFF',
        textTertiary: '#98989F',
        textBrand: '#4C8DFF',
        gridLine: '#3A3A3C',
        // Course-block text stays dark-on-pastel in both schemes — the
        // Figma palette is a set of light pastels that a white/light label
        // would go unreadable on, dark mode included.
        blockText: '#333D4B',
      }
    : {
        cardBg: '#FFFFFF',
        textPrimary: '#191F28',
        textTertiary: '#8B95A1',
        textBrand: '#0061FF',
        gridLine: '#E5E8EB',
        blockText: '#333D4B',
      };

  // Grid scale: 12 hours (08:00–20:00) at 40pt/hr — tall enough that a
  // typical 50–75min class block comfortably fits its two lines of text
  // (name + room) without cramming (24pt/hr, tried first, left blocks
  // visibly squeezed and room text clipped in short ones). The tradeoff is
  // fewer hours visible before the widget's own fixed height clips the
  // grid — like Figma's own frame (its background grid is taller than its
  // visible card and gets clipped, per its own `overflow-clip` class),
  // classes past the grid's range simply get cut off rather than shown.
  // Not a bug: a home screen widget has no scrolling, so *something* has to
  // give for a day with enough classes, and taller, readable blocks matter
  // more here than showing the entire day at once.
  const START_HOUR = 8;
  const END_HOUR = 20;
  const HOUR_HEIGHT = 40;
  const TIME_AXIS_WIDTH = 20;
  const hours = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i);
  const totalGridHeight = hours.length * HOUR_HEIGHT;
  const minutesToHeight = (minutes: number) => (minutes / 60) * HOUR_HEIGHT;

  // The background hour grid — one thin line at the top of every hour row,
  // `totalGridHeight` tall overall. This is the piece the foreground (below)
  // has to land on top of and line up with, which is why both use the same
  // `HOUR_HEIGHT`/`START_HOUR` constants rather than independent numbers.
  //
  // A plain `Rectangle` here, not `Divider` — inu-portal-web's own
  // `TimetableGrid.tsx` (`GridBackgroundCell`) uses `#f0f0f0` for grid
  // lines in both its header and body cells, but `Divider`'s Android
  // mapping hardcodes `Color.LightGray` regardless of any modifier passed
  // to it (a real renderer limitation — it doesn't read `background` off
  // its own modifiers at all). `Rectangle` does, so it's the one that
  // actually matches the design's color, in both light and dark mode.
  const hourGrid = () => (
    <VStack spacing={0} modifiers={[frame({ maxWidth: Infinity })]}>
      {hours.map((hour) => (
        <VStack key={hour} spacing={0} modifiers={[frame({ maxWidth: Infinity, height: HOUR_HEIGHT })]}>
          <Rectangle modifiers={[frame({ maxWidth: Infinity, height: 1 }), background(colors.gridLine)]} />
        </VStack>
      ))}
    </VStack>
  );

  // The vertical counterpart — inu-portal-web's grid has a `border-right` on
  // every column except the last (`$isLastDay` in `GridBackgroundCell`), so
  // there's a line after the time axis and after every day column but the
  // final one. Same `Rectangle`-not-`Divider` reasoning as `hourGrid` above,
  // just the other axis.
  const verticalLine = (key: string) => (
    <Rectangle key={key} modifiers={[frame({ width: 1, height: totalGridHeight }), background(colors.gridLine)]} />
  );

  // A day's classes, laid out as alternating gap-`Spacer`s and blocks
  // instead of absolute positions — see this file's module doc comment for
  // why. `startMinutes`/`durationMinutes` are relative to `START_HOUR`, so a
  // class starting before `START_HOUR` or a gap would go negative; both are
  // clamped to 0 rather than thrown, since a bad sample/fetch shouldn't
  // crash the whole grid over one row.
  const dayColumn = (blocks: ClassBlock[], dayIndex: number) => {
    const sorted = [...blocks].sort((a, b) => a.startMinutes - b.startMinutes);
    let cursorMinutes = 0;
    const children: ReactNode[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      const startMinutes = Math.max(0, item.startMinutes);
      const gap = Math.max(0, startMinutes - cursorMinutes);
      if (gap > 0) {
        children.push(<Spacer key={`gap-${i}`} modifiers={[frame({ height: minutesToHeight(gap) })]} />);
      }
      children.push(
        <VStack
          key={`block-${i}`}
          alignment="leading"
          spacing={1}
          modifiers={[
            frame({ maxWidth: Infinity, height: minutesToHeight(item.durationMinutes) }),
            padding({ horizontal: 4, vertical: 2 }),
            background(item.color),
            cornerRadius(4),
          ]}
        >
          <Text modifiers={[font({ size: 11, weight: 'bold' }), foregroundStyle(colors.blockText)]}>
            {item.className}
          </Text>
          <Text modifiers={[font({ size: 10, weight: 'medium' }), foregroundStyle(colors.blockText)]}>
            {item.room}
          </Text>
        </VStack>
      );
      cursorMinutes = startMinutes + item.durationMinutes;
    }
    return (
      <ZStack key={dayIndex} alignment="top" modifiers={[frame({ maxWidth: Infinity, height: totalGridHeight })]}>
        {hourGrid()}
        <VStack spacing={0} modifiers={[frame({ maxWidth: Infinity })]}>
          {children}
        </VStack>
      </ZStack>
    );
  };

  let content;
  switch (props.status) {
    case 'normal':
      content = (
        <>
          <HStack spacing={0} alignment="center" modifiers={[frame({ maxWidth: Infinity })]}>
            {/* Invisible spacer matching the time-axis column's width below,
                so the weekday headers line up with their grid columns. */}
            <Rectangle modifiers={[frame({ width: TIME_AXIS_WIDTH, height: 1 })]} />
            {WEEKDAY_LABELS.map((label, index) => (
              <Text
                key={label}
                modifiers={[
                  font({ size: 12, weight: 'medium' }),
                  foregroundStyle(index === props.todayIndex ? colors.textBrand : colors.textTertiary),
                  frame({ maxWidth: Infinity, alignment: 'center' }),
                ]}
              >
                {label}
              </Text>
            ))}
          </HStack>
          <HStack spacing={0} alignment="top" modifiers={[frame({ maxWidth: Infinity })]}>
            <VStack spacing={0} modifiers={[frame({ width: TIME_AXIS_WIDTH })]}>
              {hours.map((hour) => (
                <VStack key={hour} spacing={0} modifiers={[frame({ height: HOUR_HEIGHT })]}>
                  <Text modifiers={[font({ size: 9 }), foregroundStyle(colors.textTertiary)]}>{hour}</Text>
                </VStack>
              ))}
            </VStack>
            {/* A line after the time axis and after every day column but
                the last — matching inu-portal-web's grid exactly (see
                `verticalLine`'s doc comment). */}
            {verticalLine('v-axis')}
            {props.classesByDay.flatMap((blocks, dayIndex) =>
              dayIndex < props.classesByDay.length - 1
                ? [dayColumn(blocks, dayIndex), verticalLine(`v-${dayIndex}`)]
                : [dayColumn(blocks, dayIndex)]
            )}
          </HStack>
        </>
      );
      break;
    case 'dayOff':
      content = (
        <VStack alignment="leading" spacing={4} modifiers={[frame({ maxHeight: Infinity })]}>
          <Text modifiers={[font({ size: 20, weight: 'semibold' }), foregroundStyle(colors.textPrimary)]}>
            오늘은 공강이에요
          </Text>
          <Text modifiers={[font({ size: 12 }), foregroundStyle(colors.textTertiary)]}>
            푹 쉬세요
          </Text>
        </VStack>
      );
      break;
    case 'noTimetable':
      content = (
        <VStack alignment="leading" spacing={4} modifiers={[frame({ maxHeight: Infinity })]}>
          <Text modifiers={[font({ size: 20, weight: 'semibold' }), foregroundStyle(colors.textPrimary)]}>
            시간표를 만들어 보세요
          </Text>
        </VStack>
      );
      break;
  }

  return (
    <VStack
      alignment="leading"
      spacing={8}
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

// Android has no equivalent of createWidget()'s implicit iOS layout capture
// (see expo-widgets-glance's README) — this explicit call is what stands in
// for it. No-op on iOS.
registerGlanceWidget('TimetableWidget', TimetableWidget);

export default createWidget('TimetableWidget', TimetableWidget);
