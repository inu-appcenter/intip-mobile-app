import { HStack, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  containerBackground,
  font,
  foregroundStyle,
  monospacedDigit,
  padding,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';

export type TestWidgetProps = {
  /** Heading above the timer. Falls back to a default when the app omits it. */
  label?: string;
  /**
   * Countdown target as epoch milliseconds. Props are handed to the widget
   * extension as JSON, so a `Date` would arrive on the other side as a string —
   * keep the wire format numeric and rebuild the `Date` inside the layout.
   */
  targetAt: number;
  /** When the app last pushed a snapshot, also epoch ms. */
  updatedAt: number;
};

/**
 * Home screen widget test bed for `expo-widgets`.
 *
 * The `'widget'` directive marks this function for extraction into the separate
 * widget JS bundle (`ExpoWidgets.bundle`, built by the package's Xcode build
 * phase). That bundle only exposes the `@expo/ui/swift-ui` components and
 * modifiers as globals — module-scope values from this file are NOT in scope
 * inside the function, so every constant it needs is declared in its body.
 *
 * The name passed to `createWidget` must match a `widgets[].name` entry in the
 * `expo-widgets` plugin config in app.json (`TestWidget`), which is what the
 * plugin turns into a Swift struct during prebuild.
 */
const TestWidget = (props: TestWidgetProps, environment: WidgetEnvironment) => {
  'widget';

  const isDark = environment.colorScheme === 'dark';
  const background = isDark ? '#1C1C1E' : '#FFFFFF';
  const primary = isDark ? '#FFFFFF' : '#111111';
  const secondary = isDark ? '#98989F' : '#6B6B70';
  const accent = '#0A84FF';

  // systemSmall has roughly half the height of the other two, so it drops the
  // footer row and shrinks the timer rather than trying to fit the same layout.
  const compact = environment.widgetFamily === 'systemSmall';

  return (
    <VStack
      alignment="leading"
      spacing={compact ? 4 : 8}
      modifiers={[
        padding({ all: 12 }),
        containerBackground(background, 'widget'),
        // Tapping anywhere on the widget opens the app.
        widgetURL('intipmobileapp://'),
      ]}
    >
      <Text modifiers={[font({ size: 12, weight: 'semibold' }), foregroundStyle(secondary)]}>
        {props.label ?? '테스트 카운트다운'}
      </Text>

      {/* `dateStyle="timer"` renders a SwiftUI self-updating timer: WidgetKit
          ticks it every second without waking our JS or spending a timeline
          entry, so a countdown costs exactly one snapshot. */}
      <Text
        date={new Date(props.targetAt)}
        dateStyle="timer"
        modifiers={[
          font({ size: compact ? 26 : 40, weight: 'bold', design: 'rounded' }),
          monospacedDigit(),
          foregroundStyle(accent),
        ]}
      />

      {!compact && (
        <>
          <Spacer />
          <HStack spacing={4}>
            <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary)]}>갱신</Text>
            <Text
              date={new Date(props.updatedAt)}
              dateStyle="time"
              modifiers={[font({ size: 11 }), foregroundStyle(primary)]}
            />
            <Spacer />
            <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary)]}>
              {environment.widgetFamily}
            </Text>
          </HStack>
        </>
      )}
    </VStack>
  );
};

export default createWidget('TestWidget', TestWidget);
