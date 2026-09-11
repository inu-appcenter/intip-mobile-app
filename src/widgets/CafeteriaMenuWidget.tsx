import { HStack, Text, VStack } from '@expo/ui/swift-ui';
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

/**
 * States for the medium "학식 메뉴" (cafeteria menu) widget, named after the
 * Figma frame. Only one frame exists today — real data fetching isn't wired
 * up yet, same as every other widget in this file (see
 * `src/widgets/refresh.ts`) — so this only has the one populated state plus
 * a fallback for whenever the cafeteria has nothing posted.
 */
export type CafeteriaMenuWidgetProps =
  | {
      status: 'normal';
      cafeteriaName: string;
      mealLabel: string;
      items: string[];
      footer: string;
    }
  | { status: 'noMenu'; cafeteriaName: string };

/** Sample snapshot, matching the Figma frame's exact sample content. */
export const DEFAULT_PROPS: CafeteriaMenuWidgetProps = {
  status: 'normal',
  cafeteriaName: '제1학생식당',
  mealLabel: '점심',
  items: ['돈까스카레', '순두부찌개', '치킨마요덮밥'],
  footer: '11:30–14:00 운영 중 · 더보기',
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
const CafeteriaMenuWidget = (props: CafeteriaMenuWidgetProps, environment: WidgetEnvironment) => {
  'widget';

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
      }
    : {
        cardBg: '#FFFFFF',
        textPrimary: '#111111',
        textSecondary: '#374151',
        textTertiary: '#9CA3AF',
        badgeBg: '#EFF6FF',
        badgeText: '#1D4ED8',
      };

  let content;
  switch (props.status) {
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
              {props.cafeteriaName}
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
              {props.mealLabel}
            </Text>
          </HStack>
          {props.items.map((item, index) => (
            <Text
              key={index}
              modifiers={[font({ size: 13 }), foregroundStyle(colors.textSecondary), frame({ maxWidth: Infinity, alignment: 'leading' })]}
            >
              {`· ${item}`}
            </Text>
          ))}
          {/* Figma pins the footer to the card's bottom edge with a
              flex-grow spacer above it. A `<Spacer />` here (Glance's
              `defaultWeight()`) is the natural translation, but confirmed
              against a real render it doesn't: the footer line went
              missing entirely — not mispositioned, just never drawn,
              unlike the symmetric-Spacer centering pattern
              NextClassWidget.tsx's `dayOff` state uses successfully. Rather
              than chase why one Spacer placement works and this one
              doesn't, the footer just follows the menu items in normal
              flow instead of being bottom-pinned — a minor layout
              deviation from Figma, not a missing feature. */}
          <Text modifiers={[font({ size: 11 }), foregroundStyle(colors.textTertiary), frame({ maxWidth: Infinity, alignment: 'leading' })]}>
            {props.footer}
          </Text>
        </>
      );
      break;
    case 'noMenu':
      content = (
        <>
          <Text modifiers={[font({ size: 15, weight: 'bold' }), foregroundStyle(colors.textPrimary)]}>
            {props.cafeteriaName}
          </Text>
          <Text modifiers={[font({ size: 13 }), foregroundStyle(colors.textTertiary)]}>
            오늘 등록된 메뉴가 없어요
          </Text>
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
registerGlanceWidget('CafeteriaMenuWidget', CafeteriaMenuWidget);

export default createWidget('CafeteriaMenuWidget', CafeteriaMenuWidget);
