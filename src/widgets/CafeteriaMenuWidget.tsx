import { HStack, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  background,
  containerBackground,
  cornerRadius,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  padding,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import { registerGlanceWidget } from 'expo-widgets-glance';

import { CAFETERIA_REFRESH_MS } from './refreshIntervals';

/**
 * One column of dishes. The widget shows up to two side by side.
 *
 * Nothing in these props may be `null`: iOS stores them in UserDefaults, which
 * rejects `NSNull` ("Attempt to set a non-property-list object"), and the push
 * then fails silently, leaving the widget on its previous snapshot.
 */
export type MenuColumn = {
  /** The corner (`1코너(백반)`), `선택`/`공통`, or the meal (`석식`) when there are no corners. */
  title: string;
  /** At most three lines, the last one `…` when the list was cut. */
  items: string[];
};

/**
 * States for one cafeteria in the medium "학식 메뉴" (cafeteria menu) widget,
 * named after the Figma frames: a meal being served, the cafeteria shut
 * between (or outside) today's meals, and a day it doesn't operate at all.
 */
export type CafeteriaSnapshot =
  | {
      status: 'normal';
      cafeteriaName: string;
      mealLabel: string;
      columns: MenuColumn[];
      footer: string;
    }
  /** Serving today, but not right now — Figma node 5297:16719. */
  | {
      status: 'closed';
      cafeteriaName: string;
      /** `운영 종료`, or `운영 전` before the first meal of the day. */
      badge: string;
      /** `다음 저녁 17:30부터`, or `오늘 운영이 끝났어요` past the last meal. */
      nextLabel: string;
      /** A few of the next meal's dishes, `제육볶음 · 된장찌개`. Empty, never null. */
      preview: string;
    }
  /** Nothing posted for today at all — Figma node 5297:16729. */
  | { status: 'notOperating'; cafeteriaName: string; message: string };

/**
 * Every cafeteria's snapshot, keyed by the `cafeteria` configuration value.
 * The app can't know which one a given widget was set to (see
 * `data/cafeteria.ts`), so it sends them all.
 */
export type CafeteriaMenuWidgetProps = {
  cafeterias: Record<string, CafeteriaSnapshot>;
};

/**
 * The per-widget option declared in app.json — once under `expo-widgets`
 * (iOS 17+) and once under `expo-widgets-glance` (Android); keep the two in sync.
 */
export type CafeteriaMenuWidgetConfiguration = {
  cafeteria: string;
};

/** Sample snapshot, matching the Figma frame's exact sample content. */
export const DEFAULT_PROPS: CafeteriaMenuWidgetProps = {
  cafeterias: {
    student12: {
      status: 'normal',
      cafeteriaName: '학생식당',
      mealLabel: '점심',
      columns: [
        { title: '1코너(백반)', items: ['돈까스카레', '순두부찌개', '…'] },
        { title: '2코너(일품)', items: ['치킨마요덮밥', '미소장국', '단무지'] },
      ],
      footer: '11:30–14:00 운영 중 · 더보기',
    },
  },
};

/**
 * Home screen widget for today's cafeteria menu.
 *
 * See the `'widget'` directive note in `TestWidget.tsx` — only this
 * function's own source and whatever it declares internally ships to the
 * widget process.
 *
 * Only `systemMedium` is designed today (the one Figma frame), so
 * `environment.widgetFamily` isn't branched on.
 *
 * Figma specs this frame in Noto Sans KR; every other widget in this app
 * uses Pretendard, and `font()`'s `design`/`family` isn't mapped by either
 * renderer yet (see expo-widgets-glance's README "Coverage") — this renders
 * in whatever the system default is, same size/weight, not the Figma
 * typeface. Not worth a special case for one widget's font family.
 */
const CafeteriaMenuWidget = (
  props: CafeteriaMenuWidgetProps,
  environment: WidgetEnvironment<CafeteriaMenuWidgetConfiguration>,
) => {
  'widget';

  // `configuration` comes from the widget's options on both platforms (iOS's
  // AppIntent, expo-widgets-glance's configure activity on Android), but can
  // still be missing — a widget placed before options existed — and so can
  // `cafeterias`, on a snapshot pushed by an older build. Both fall back to
  // 학생식당 1·2코너, the default app.json declares. Literal rather than
  // imported: only this function's source reaches the widget.
  const snapshot: CafeteriaSnapshot = props.cafeterias?.[environment.configuration?.cafeteria ?? 'student12'] ??
    props.cafeterias?.student12 ?? { status: 'notOperating', cafeteriaName: '학식 메뉴', message: '오늘 등록된 메뉴가 없어요' };

  const isDark = environment.colorScheme === 'dark';

  // The Figma frame only specs light mode — dark values extend the same
  // semantic tokens the other widgets in this bundle already use, mapped
  // from this frame's raw hex (it wasn't built against the shared design
  // tokens the other widgets were, so there's no light/dark pair to copy).
  const colors = isDark
    ? {
        cardBg: '#1C1C1E',
        textPrimary: '#FFFFFF',
        textSecondary: '#D1D1D6',
        textTertiary: '#98989F',
        badgeBg: '#13223A',
        badgeText: '#4C8DFF',
        neutralBadgeBg: '#2C2C2E',
        neutralBadgeText: '#98989F',
        textMuted: '#98989F',
      }
    : {
        cardBg: '#FFFFFF',
        textPrimary: '#111111',
        textSecondary: '#374151',
        textTertiary: '#9CA3AF',
        badgeBg: '#EFF6FF',
        badgeText: '#1D4ED8',
        neutralBadgeBg: '#F3F4F6',
        neutralBadgeText: '#6B7280',
        textMuted: '#6B7280',
      };

  let content;
  switch (snapshot.status) {
    case 'normal':
      content = (
        <>
          <HStack spacing={8} alignment="center" modifiers={[frame({ maxWidth: Infinity })]}>
            <Text
              modifiers={[
                font({ size: 15, weight: 'bold' }),
                foregroundStyle(colors.textPrimary),
                frame({ maxWidth: Infinity, alignment: 'leading' }),
              ]}
            >
              {snapshot.cafeteriaName}
            </Text>
            <Text
              modifiers={[
                font({ size: 10, weight: 'medium' }),
                foregroundStyle(colors.badgeText),
                padding({ horizontal: 8, vertical: 3 }),
                background(colors.badgeBg),
                cornerRadius(8),
              ]}
            >
              {snapshot.mealLabel}
            </Text>
          </HStack>
          {/* The map MUST stay wrapped in its own container rather than
              sitting inline among these siblings. expo-widgets serializes
              the element tree to JSON and walks it in
              `ios/Widgets/DynamicView.swift`'s `updateChildren`, which reads
              children as `compactMap { $0 as? [String: Any] }` — it never
              flattens. A `.map()` next to sibling elements arrives as a
              nested array, fails that cast, and is dropped *silently*: the
              three menu lines simply never rendered on device while the
              header and footer around them did. As its own container's only
              child the array is the children value itself, which does cast,
              which is why the same pattern works in TodayClassesWidget and
              BusArrivalWidget. The same holds one level down: each
              column's dish map sits alone in its own VStack, not next to
              the column title.
              (This is also what broke the `<Spacer />` below when it was
              first tried — see git history; the layout it was inserted into
              was already missing its menu lines.) */}
          <HStack alignment="top" spacing={12} modifiers={[frame({ maxWidth: Infinity })]}>
            {snapshot.columns.map((column, columnIndex) => (
              <VStack
                key={columnIndex}
                alignment="leading"
                spacing={4}
                modifiers={[frame({ maxWidth: Infinity, alignment: 'topLeading' })]}
              >
                <Text modifiers={[font({ size: 11, weight: 'semibold' }), foregroundStyle(colors.badgeText), lineLimit(1)]}>
                  {column.title}
                </Text>
                <VStack alignment="leading" spacing={4} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
                  {column.items.map((item, index) => (
                    <Text
                      key={index}
                      modifiers={[
                        font({ size: 13 }),
                        foregroundStyle(colors.textSecondary),
                        lineLimit(1),
                        frame({ maxWidth: Infinity, alignment: 'leading' }),
                      ]}
                    >
                      {item}
                    </Text>
                  ))}
                </VStack>
              </VStack>
            ))}
          </HStack>
          {/* Figma pins the footer to the card's bottom edge (node 5297:16707
              has a flex-grow filler frame above it); the widget's real height
              isn't the frame's 170, so a Spacer is the translation. */}
          <Spacer />
          <Text modifiers={[font({ size: 11 }), foregroundStyle(colors.textTertiary), frame({ maxWidth: Infinity, alignment: 'leading' })]}>
            {snapshot.footer}
          </Text>
        </>
      );
      break;
    case 'closed':
      content = (
        <>
          <HStack spacing={8} alignment="center" modifiers={[frame({ maxWidth: Infinity })]}>
            <Text
              modifiers={[
                font({ size: 15, weight: 'bold' }),
                foregroundStyle(colors.textPrimary),
                frame({ maxWidth: Infinity, alignment: 'leading' }),
              ]}
            >
              {snapshot.cafeteriaName}
            </Text>
            <Text
              modifiers={[
                font({ size: 10, weight: 'medium' }),
                foregroundStyle(colors.neutralBadgeText),
                padding({ horizontal: 8, vertical: 3 }),
                background(colors.neutralBadgeBg),
                cornerRadius(8),
              ]}
            >
              {snapshot.badge}
            </Text>
          </HStack>
          {/* Same bottom-pinned block as the populated frame: node 5297:16724
              is the flex-grow filler above these two lines. */}
          <Spacer />
          <Text
            modifiers={[
              font({ size: 16, weight: 'bold' }),
              foregroundStyle(colors.textPrimary),
              lineLimit(1),
              frame({ maxWidth: Infinity, alignment: 'leading' }),
            ]}
          >
            {snapshot.nextLabel}
          </Text>
          <Text
            modifiers={[
              font({ size: 12 }),
              foregroundStyle(colors.textMuted),
              lineLimit(1),
              frame({ maxWidth: Infinity, alignment: 'leading' }),
            ]}
          >
            {snapshot.preview}
          </Text>
        </>
      );
      break;
    case 'notOperating':
      // Figma centers this frame's two lines vertically (node 5297:16729 is
      // `justify-center`); the Spacer pair is the translation, the same way
      // the other states pin their footer to the bottom.
      content = (
        <>
          <Spacer />
          <Text
            modifiers={[
              font({ size: 13, weight: 'medium' }),
              foregroundStyle(colors.textTertiary),
              frame({ maxWidth: Infinity, alignment: 'leading' }),
            ]}
          >
            {snapshot.cafeteriaName}
          </Text>
          <Text
            modifiers={[
              font({ size: 17, weight: 'bold' }),
              foregroundStyle(colors.textPrimary),
              frame({ maxWidth: Infinity, alignment: 'leading' }),
            ]}
          >
            {snapshot.message}
          </Text>
          <Spacer />
        </>
      );
      break;
  }

  return (
    <VStack
      alignment="leading"
      spacing={6}
      modifiers={[
        padding({ all: 14 }),
        containerBackground(colors.cardBg, 'widget'),
        // See NextClassWidget.tsx's identical modifier for why both axes
        // and `topLeading` are needed here.
        frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'topLeading' }),
        // Opens the portal's menu page on this widget's cafeteria — the same
        // `?category=` the web home's own menu card navigates with. The
        // placeholder snapshot (no data yet) has no real cafeteria to name.
        // See `widgetPortalPath` in src/links/deepLink.ts for the routing.
        widgetURL(
          snapshot.cafeteriaName === '학식 메뉴'
            ? 'intipmobileapp://widget/home/menu'
            : `intipmobileapp://widget/home/menu?category=${encodeURIComponent(snapshot.cafeteriaName)}`,
        ),
      ]}
    >
      {content}
    </VStack>
  );
};

// Android has no equivalent of createWidget()'s implicit iOS layout capture
// (see expo-widgets-glance's README) — this explicit call is what stands in
// for it. No-op on iOS.
registerGlanceWidget('CafeteriaMenuWidget', CafeteriaMenuWidget, { refreshIntervalMs: CAFETERIA_REFRESH_MS });

export default createWidget('CafeteriaMenuWidget', CafeteriaMenuWidget);
