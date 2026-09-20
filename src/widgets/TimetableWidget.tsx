import type { ReactNode } from 'react';

import { HStack, Rectangle, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  background,
  containerBackground,
  cornerRadius,
  font,
  foregroundStyle,
  frame,
  multilineTextAlignment,
  offset,
  padding,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import { registerGlanceWidget } from 'expo-widgets-glance';

import { SCHEDULE_REFRESH_MS } from './refreshIntervals';

/** One class block: when it happens (minutes since the grid's first hour), how long, and the pastel color Figma assigns it. */
export type ClassBlock = {
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

  // Grid scale.
  //
  // The hour height is *derived* from the widget's real height, not picked
  // by eye. Everything from `START_HOUR` through `END_HOUR - 1` has to be on
  // screen — a widget cannot scroll, so an hour that doesn't fit is an hour
  // the user can never see, and an 18:30 class silently missing is worse
  // than every block being a little shorter. Dividing the real height also
  // means no dead space under the grid.
  //
  // `environment.height` is Android-only for now: expo-widgets-glance
  // reports the size the *launcher* gave this instance, which is the only
  // way to know it there — an Android home screen hands out whole grid cells
  // whose dp size depends on the device and the user's chosen grid, so
  // "systemLarge" is a family, not a measurement. Measured on a 420dpi
  // phone: a 4-cell-tall slot is ~414dp while the widget's own declared
  // `minHeight` is 300dp.
  //
  // iOS has no equivalent — `expo-widgets`' `getWidgetEnvironment` doesn't
  // report a size — so it falls back to the budget below, measured by hand
  // from `systemLarge` on a 393pt-wide iPhone (338x354, out of which 354
  // minus this widget's own chrome leaves ~295). The 364x382 the Figma frame
  // was drawn against is the 428pt-wide class, i.e. the roomy case, so
  // sizing to the tight one is the safe direction. Worth replacing with a
  // real measurement if expo-widgets ever exposes one.
  const START_HOUR = 8;
  // Fixed, not derived from the data: the grid always shows 08:00-20:00
  // (labels 8 through 19), whatever the timetable holds. Stretching it to fit
  // the latest class was tried and dropped — a single 22:00 meeting squeezed
  // every hour row to ~19pt, too short for a class name plus its room.
  // Classes that start at 20:00 or later are not drawn; ones running past it
  // are cut at the bottom edge (see `dayColumn`).
  const END_HOUR = 20;
  const gridMinutes = (END_HOUR - START_HOUR) * 60;
  /** Root padding (20 + 16), the VStack's spacing, and the weekday header. */
  const CHROME_HEIGHT = 20 + 16 + 8 + 15;
  const IOS_GRID_HEIGHT_BUDGET = 295;
  const environmentHeight = (environment as { height?: number }).height;
  const gridHeightBudget =
    typeof environmentHeight === 'number' && environmentHeight > 0
      ? environmentHeight - CHROME_HEIGHT
      : IOS_GRID_HEIGHT_BUDGET;
  // Floored so the rows always fit inside the budget rather than overflowing
  // it by a fraction, and clamped so a very short widget degrades into
  // something still legible instead of hairline rows.
  const HOUR_HEIGHT = Math.max(18, Math.floor(gridHeightBudget / (END_HOUR - START_HOUR)));
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
        <VStack
          key={hour}
          spacing={0}
          modifiers={[frame({ maxWidth: Infinity, height: HOUR_HEIGHT, alignment: 'top' })]}
        >
          {/* `foregroundStyle`, not `background` — a bare SwiftUI
              `Rectangle()` (which is all @expo/ui's RectangleView is) fills
              itself with the *foreground* style, defaulting to black, and a
              `background` paints uselessly behind something already opaque.
              That is why these lines rendered black on iOS. Android gets the
              same result: expo-widgets-glance routes `foregroundStyle` to a
              shape node's fill (see its `shapeFill`). */}
          <Rectangle modifiers={[frame({ maxWidth: Infinity, height: 1 }), foregroundStyle(colors.gridLine)]} />
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
    <Rectangle
      key={key}
      modifiers={[frame({ width: 1, height: totalGridHeight }), foregroundStyle(colors.gridLine)]}
    />
  );

  // A day's classes, laid out as alternating gap-`Spacer`s and blocks
  // instead of absolute positions — see this file's module doc comment for
  // why. `startMinutes`/`durationMinutes` are relative to `START_HOUR`, so a
  // class starting before `START_HOUR` or a gap would go negative; both are
  // clamped to 0 rather than thrown, since a bad sample/fetch shouldn't
  // crash the whole grid over one row.
  //
  // Deliberately does NOT wrap its own `hourGrid()` in a per-day `ZStack`
  // the way an earlier version of this file did — that meant 5 `ZStack`s
  // (one per weekday) each drawing their own full 12-row background, ~60
  // `Rectangle`s total for one grid. On-device that combination (multiple
  // `ZStack`s side by side in the outer `HStack`, each `frame(maxWidth:
  // Infinity)`) rendered as an empty widget — no weekday columns, no grid,
  // nothing but the time axis — while the exact same structure with only
  // 1–2 day columns rendered fine. Whatever the ceiling is exactly, the fix
  // isn't chasing it: draw the hour grid ONCE behind every day column (see
  // the single `ZStack` in the `'normal'` case below) instead of once per
  // column, which is both far lighter and the more obviously correct
  // structure regardless — one grid, not five overlapping copies of it.
  const dayColumn = (blocks: ClassBlock[], dayIndex: number) => {
    const sorted = [...blocks].sort((a, b) => a.startMinutes - b.startMinutes);
    let cursorMinutes = 0;
    const children: ReactNode[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      const startMinutes = Math.max(0, item.startMinutes);
      // Past END_HOUR there is no row to draw on. Clamp rather than let a
      // column grow past the grid: an overflowing column is centred in the
      // grid's fixed-height frame, which shifts every block in it upward.
      if (startMinutes >= gridMinutes) continue;
      const durationMinutes = Math.min(item.durationMinutes, gridMinutes - startMinutes);
      const gap = Math.max(0, startMinutes - cursorMinutes);
      if (gap > 0) {
        children.push(<Spacer key={`gap-${i}`} modifiers={[frame({ height: minutesToHeight(gap) })]} />);
      }
      children.push(
        <VStack
          key={`block-${i}`}
          alignment="leading"
          spacing={1}
          // `padding` before `frame`, so the frame's height *is* the block's
          // outer height. The other way round, SwiftUI wraps the padding
          // outside the frame and each block came out 4pt taller than its
          // duration — pushing every later class in the column a little
          // further down, cumulatively. expo-widgets-glance follows the same
          // rule (only padding *after* a fixed frame is added to it).
          modifiers={[
            padding({ horizontal: 4, vertical: 2 }),
            frame({ maxWidth: Infinity, height: minutesToHeight(durationMinutes), alignment: 'topLeading' }),
            background(item.color),
            cornerRadius(4),
          ]}
        >
          {/* `multilineTextAlignment('leading')` on top of the VStack's own
              `alignment="leading"` — the VStack alignment only places each
              Text's block within the column; once a name wraps to 2–3
              lines, SwiftUI centers those wrapped lines against each other
              by default, which read as centered text even with the block
              itself pinned left. `frame({maxWidth: Infinity, alignment:
              'leading'})` additionally stops each Text from just hugging
              its own (narrower, wrapped) intrinsic width — without it the
              multiline alignment has no extra width to align *within*. */}
          <Text
            modifiers={[
              font({ size: 11, weight: 'bold' }),
              foregroundStyle(colors.blockText),
              multilineTextAlignment('leading'),
              frame({ maxWidth: Infinity, alignment: 'leading' }),
            ]}
          >
            {item.className}
          </Text>
          <Text
            modifiers={[
              font({ size: 10, weight: 'medium' }),
              foregroundStyle(colors.blockText),
              multilineTextAlignment('leading'),
              frame({ maxWidth: Infinity, alignment: 'leading' }),
            ]}
          >
            {item.room}
          </Text>
        </VStack>
      );
      cursorMinutes = startMinutes + durationMinutes;
    }
    return (
      <VStack key={dayIndex} spacing={0} modifiers={[frame({ maxWidth: Infinity })]}>
        {children}
      </VStack>
    );
  };

  let content;
  switch (props.status) {
    case 'normal':
      content = (
        <>
          <HStack spacing={0} alignment="center" modifiers={[frame({ maxWidth: Infinity })]}>
            {/* Invisible spacer matching the time-axis column's width below,
                so the weekday headers line up with their grid columns.
                Height 0, not 1: with no `foregroundStyle` a `Rectangle` fills
                itself black on iOS (see `hourGrid`), so a 1pt one drew a
                visible black dash here. A zero-height rect still reserves its
                width in the row while painting nothing on either platform.
                A `Spacer` is not an option — expo-widgets-glance renders any
                `SpacerView` inside a Row as `defaultWeight()`, ignoring the
                fixed width this needs. */}
            <Rectangle modifiers={[frame({ width: TIME_AXIS_WIDTH, height: 0 })]} />
            {/* Wrapped, not inline next to the spacer above: a `.map()`
                sitting among siblings serializes to a nested array, which
                `ios/Widgets/DynamicView.swift`'s `updateChildren` drops
                silently (it casts each child with `as? [String: Any]` and
                never flattens) — the whole weekday header would render as
                just the invisible spacer. See the longer note in
                CafeteriaMenuWidget.tsx, where this bug was actually caught.
                As this HStack's only child the array casts fine, and the
                fill-width frame keeps the five labels dividing the row's
                remaining width evenly the way they did as direct children. */}
            <HStack spacing={0} alignment="center" modifiers={[frame({ maxWidth: Infinity })]}>
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
          </HStack>
          <HStack spacing={0} alignment="top" modifiers={[frame({ maxWidth: Infinity })]}>
            <VStack spacing={0} modifiers={[frame({ width: TIME_AXIS_WIDTH })]}>
              {hours.map((hour) => (
                <VStack
                  key={hour}
                  spacing={0}
                  modifiers={[frame({ height: HOUR_HEIGHT, alignment: 'top' })]}
                >
                  {/* `alignment: 'top'` pins the label to the row's top edge —
                      matching the grid line (`hourGrid`) and every class
                      block's `minutesToHeight`-based Spacer, both of which
                      measure from that same top edge, not the row's
                      vertical center. Without this, an on-the-hour class
                      visibly starts *above* the hour it's labeled with (the
                      label was floating at its row's midpoint — the
                      half-hour mark — while the block itself landed exactly
                      on the hour). The `offset` lifts the label so its centre sits *on* the
                      line. -2.5, not the ~-5 the text metrics suggest: measured on
                      zoomed simulator screenshots, `offset` here moves about twice
                      its value (0 hung labels ~5pt below their lines, -5 put them
                      ~5pt above). Android ignores `offset` — Glance has none. */}
                  <Text
                    modifiers={[
                      font({ size: 9 }),
                      foregroundStyle(colors.textTertiary),
                      offset({ y: -2.5 }),
                    ]}
                  >
                    {hour}
                  </Text>
                </VStack>
              ))}
            </VStack>
            {/* A line after the time axis and after every day column but
                the last — matching inu-portal-web's grid exactly (see
                `verticalLine`'s doc comment). */}
            {verticalLine('v-axis')}
            {/* One shared hour grid behind every day column, not one per
                column — see `dayColumn`'s doc comment for why. */}
            {/* `alignment: 'top'` on the frame, not just the ZStack: the
                ZStack's own alignment only lines its children up with each
                other. The frame decides where the ZStack sits when it doesn't
                exactly match the fixed height, and its default is centre. */}
            <ZStack alignment="top" modifiers={[frame({ maxWidth: Infinity, height: totalGridHeight, alignment: 'top' })]}>
              {hourGrid()}
              <HStack spacing={0} alignment="top" modifiers={[frame({ maxWidth: Infinity })]}>
                {props.classesByDay.flatMap((blocks, dayIndex) =>
                  dayIndex < props.classesByDay.length - 1
                    ? [dayColumn(blocks, dayIndex), verticalLine(`v-${dayIndex}`)]
                    : [dayColumn(blocks, dayIndex)]
                )}
              </HStack>
            </ZStack>
          </HStack>
        </>
      );
      break;
    case 'dayOff':
      content = (
        <VStack alignment="leading" spacing={4} modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'topLeading' })]}>
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
        <VStack alignment="leading" spacing={4} modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'topLeading' })]}>
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
        // See NextClassWidget.tsx's identical modifier for why both axes
        // and `topLeading` are needed here.
        frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'topLeading' }),
        // Tapping anywhere on the widget opens the app.
        // Opens the portal's timetable tab — see `widgetPortalPath` in
        // src/links/deepLink.ts for how `widget/...` links are routed.
        widgetURL('intipmobileapp://widget/timetable'),
      ]}
    >
      {content}
    </VStack>
  );
};

// Android has no equivalent of createWidget()'s implicit iOS layout capture
// (see expo-widgets-glance's README) — this explicit call is what stands in
// for it. No-op on iOS.
registerGlanceWidget('TimetableWidget', TimetableWidget, { refreshIntervalMs: SCHEDULE_REFRESH_MS });

export default createWidget('TimetableWidget', TimetableWidget);
