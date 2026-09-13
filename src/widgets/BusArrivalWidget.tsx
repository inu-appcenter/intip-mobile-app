import { HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  containerBackground,
  font,
  foregroundStyle,
  frame,
  padding,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";
import { registerGlanceWidget } from "expo-widgets-glance";

/** One bus route's next arrival. */
type BusArrival = {
  route: string;
  /**
   * The estimate as of `observedLabel`, already formatted ("4분 19초",
   * "곧 도착"). Android renders this; iOS only falls back to it.
   *
   * On Android this number does not tick down — Glance has no self-updating
   * text, so it is only as fresh as the last refresh, which is why the
   * "기준" line under it is not optional.
   */
  eta: string;
  /** The design's one emphasized case ("곧 도착") gets the brand color instead of tertiary. */
  soon?: boolean;
  /**
   * When the bus is expected, as an epoch millisecond timestamp.
   *
   * An absolute instant, not a duration, and that is the whole point: a
   * widget cannot be refreshed once a minute on either platform (Android's
   * WorkManager floor is 15 minutes; iOS meters timeline reloads), so a
   * stored "4분 19초" is wrong almost immediately. An instant stays true, and
   * iOS can count down to it on its own clock with no refresh at all.
   *
   * Numeric because the snapshot crosses into the widget process as JSON —
   * a `Date` would arrive as a string (same reason `TestWidget` does this).
   */
  arrivesAt: number;
  /** How old the reading is ("2분 전 기준"), for the honesty line below. */
  observedLabel: string;
};

/**
 * States for the small "인입런" (shuttle/bus arrival) widget, named after the
 * Figma frame (학교갈래요/인입런). Only one frame exists today — real data
 * fetching isn't wired up, same as every other widget in this file (see
 * `src/widgets/refresh.ts`) — so this only has the one populated state plus
 * a fallback for whenever the upstream arrival API has nothing to show.
 */
export type BusArrivalWidgetProps =
  | { status: "normal"; exitLabel: string; arrivals: BusArrival[] }
  | { status: "noData" };

/** Sample snapshot, matching the Figma frame's exact sample content. */
export const DEFAULT_PROPS: BusArrivalWidgetProps = {
  status: "normal",
  exitLabel: "2번 출구",
  arrivals: [
    { route: "6-1", eta: "곧 도착", soon: true, arrivesAt: Date.now() + 30_000, observedLabel: "방금 기준" },
    { route: "8", eta: "4분 19초", arrivesAt: Date.now() + 259_000, observedLabel: "방금 기준" },
    { route: "순환41", eta: "16분 41초", arrivesAt: Date.now() + 1_001_000, observedLabel: "방금 기준" },
  ],
};

/**
 * Home screen widget for the nearest bus stop's next arrivals.
 *
 * See the `'widget'` directive note in `TestWidget.tsx` — only this
 * function's own source and whatever it declares internally ships to the
 * widget process.
 *
 * Only `systemSmall` is designed today (the one Figma frame), so
 * `environment.widgetFamily` isn't branched on.
 */
const BusArrivalWidget = (
  props: BusArrivalWidgetProps,
  environment: WidgetEnvironment,
) => {
  "widget";

  const isDark = environment.colorScheme === "dark";

  // The Figma frame only specs light mode — dark values extend the same
  // semantic tokens the other widgets in this bundle already use.
  const colors = isDark
    ? {
        cardBg: "#1C1C1E",
        textPrimary: "#FFFFFF",
        textSecondary: "#EBEBF0",
        textTertiary: "#98989F",
        textBrand: "#4C8DFF",
      }
    : {
        cardBg: "#FFFFFF",
        textPrimary: "#191F28",
        textSecondary: "#333D4B",
        textTertiary: "#8B95A1",
        textBrand: "#0061FF",
      };

  // Ported from inu-portal-web's busCircleTone.ts (`getBusCircleTone`) +
  // BusCircle.tsx's tone→color mapping — NOT SwipeBusWidget.tsx's own
  // `getBusColor`, which was tried first and turned out to have a real bug:
  // it hardcodes "순환41" into its blue bucket, while busCircleTone.ts's
  // prefix rule (anything starting with "순환" is green) is what every other
  // bus-route color in that app actually uses (BusCircle/BusCircleList/
  // BusHistoryModal/BusItem/BusMapPanel), and is the correct answer for a
  // circular-route number like this one. Kept in sync by hand since there's
  // no shared package between the two repos. Declared inside the widget
  // function, not at module scope: see the `'widget'` directive note above —
  // only this function's own source ships to the widget process.
  const RED_BUS_NUMBERS = [
    "1301",
    "3002",
    "303-1",
    "6405",
    "M6405",
    "M6464",
    "6724",
    "6777",
  ];
  const busColor = (route: string): string => {
    if (
      route.startsWith("순환") ||
      ["41", "42", "43", "46", "47"].includes(route)
    ) {
      return "#2C9B37";
    }
    if (route.startsWith("M") || RED_BUS_NUMBERS.includes(route)) {
      return "#D64A3A";
    }
    return "#1B4E9B";
  };

  // The route icon is inu-portal-web's fontello glyph `icon-bus` — literally
  // the same glyph the web app renders — tinted per-route the way its
  // `BusIcon` does. See `plugins/withWidgetAssets.js` for where it was lifted
  // from.
  //
  // `assetName`, not `systemName`: an SF Symbol name is iOS-only vocabulary
  // with nothing on Android to resolve it against. One `assetName` resolves
  // on both — `plugins/withWidgetAssets.js` generates the iOS imageset and
  // the Android vector drawable from that one tracked SVG, and both are
  // monochrome templates, so `color` below stays the only place the palette
  // is written down.
  const row = (arrival: BusArrival, key: number) => (
    <HStack
      key={key}
      alignment="center"
      modifiers={[frame({ maxWidth: Infinity })]}
    >
      <HStack
        spacing={4}
        alignment="center"
        modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
      >
        <Image
          assetName="BusIcon"
          color={busColor(arrival.route)}
          // The source artwork is a 1000-unit em (fontello), rendered at a
          // 24 natural size on both platforms, so the frame is what brings it
          // down to the 16 this row wants. `resizable()` is
          // what makes the frame actually resize it rather than crop it —
          // and it is also why there is no `size` prop here: `size` becomes a
          // `font` modifier (see @expo/ui's `transformNativeProps`), which
          // sizes an SF Symbol but does nothing at all to an asset image.
          modifiers={[resizable(), frame({ width: 16, height: 16 })]}
        />
        <Text
          modifiers={[
            font({ size: 16, weight: "semibold" }),
            foregroundStyle(colors.textPrimary),
          ]}
        >
          {arrival.route}
        </Text>
      </HStack>
      {/* `dateStyle="timer"` is a self-updating SwiftUI text: on iOS WidgetKit
          reruns it on its own clock, so this counts down second by second
          with no timeline reload and no network. expo-widgets-glance renders
          the same node as a RemoteViews Chronometer, which the launcher ticks
          for itself — so it is live on both platforms now.

          The countdown being live does not make the *estimate* live: it runs
          toward an instant derived from whenever the transit API was last
          read, which is what the footer's "기준" time states. */}
      <Text
        date={new Date(arrival.arrivesAt)}
        dateStyle="timer"
        modifiers={[
          font({ size: 12, weight: arrival.soon ? "medium" : "regular" }),
          foregroundStyle(
            arrival.soon ? colors.textBrand : colors.textTertiary,
          ),
        ]}
      />
    </HStack>
  );

  let content;
  switch (props.status) {
    case "normal":
      content = (
        <>
          <HStack
            alignment="center"
            modifiers={[frame({ maxWidth: Infinity })]}
          >
            <Text
              modifiers={[
                font({ size: 14, weight: "medium" }),
                foregroundStyle(colors.textTertiary),
              ]}
            >
              인입런
            </Text>
            {/* An explicit Spacer, not `frame({maxWidth:Infinity,
                alignment:'trailing'})` on the second Text — this is the
                pattern TodayClassesWidget.tsx's own header row already uses
                and confirmed working; the frame-based approach left the two
                labels sitting close together instead of pushed to opposite
                edges. */}
            <Spacer />
            <Text
              modifiers={[
                font({ size: 14, weight: "semibold" }),
                foregroundStyle(colors.textSecondary),
              ]}
            >
              {props.exitLabel}
            </Text>
          </HStack>
          <VStack
            spacing={8}
            alignment="leading"
            modifiers={[frame({ maxWidth: Infinity })]}
          >
            {props.arrivals.map((arrival, index) => row(arrival, index))}
          </VStack>
          {/* How old the estimates are. Not decoration and not an apology:
              on Android the times above are frozen at the last widget update
              (Glance cannot tick), and even on iOS, where they do count down,
              the countdown is only as good as the reading it started from —
              the bus may already have been rerouted. Stating the age is the
              only way the number isn't a quiet lie. */}
          <Spacer />
          <Text
            modifiers={[
              font({ size: 10 }),
              foregroundStyle(colors.textTertiary),
              frame({ maxWidth: Infinity, alignment: "leading" }),
            ]}
          >
            {props.arrivals[0].observedLabel}
          </Text>
        </>
      );
      break;
    case "noData":
      content = (
        <VStack
          alignment="leading"
          spacing={4}
          modifiers={[
            frame({
              maxWidth: Infinity,
              maxHeight: Infinity,
              alignment: "topLeading",
            }),
          ]}
        >
          <Text
            modifiers={[
              font({ size: 14, weight: "medium" }),
              foregroundStyle(colors.textTertiary),
            ]}
          >
            인입런
          </Text>
          <Text
            modifiers={[
              font({ size: 16, weight: "semibold" }),
              foregroundStyle(colors.textPrimary),
            ]}
          >
            도착 정보 없음
          </Text>
        </VStack>
      );
      break;
  }

  return (
    <VStack
      alignment="leading"
      spacing={16}
      modifiers={[
        padding({ top: 20, bottom: 16, leading: 16, trailing: 16 }),
        containerBackground(colors.cardBg, "widget"),
        // See NextClassWidget.tsx's identical modifier for why both axes
        // and `topLeading` are needed here.
        frame({
          maxWidth: Infinity,
          maxHeight: Infinity,
          alignment: "topLeading",
        }),
        // Tapping anywhere on the widget opens the app.
        widgetURL("intipmobileapp://"),
      ]}
    >
      {content}
    </VStack>
  );
};

// Android has no equivalent of createWidget()'s implicit iOS layout capture
// (see expo-widgets-glance's README) — this explicit call is what stands in
// for it. No-op on iOS.
registerGlanceWidget("BusArrivalWidget", BusArrivalWidget);

export default createWidget("BusArrivalWidget", BusArrivalWidget);
