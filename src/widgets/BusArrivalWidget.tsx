import { Button, HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  containerBackground,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  multilineTextAlignment,
  padding,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";
import { registerGlanceWidget } from "expo-widgets-glance";

import { BUS_REFRESH_MS } from "./refreshIntervals";

/** One bus route's next arrival. */
type BusArrival = {
  route: string;
  /**
   * The estimate as of `observedLabel`, already formatted ("4분 19초",
   * "곧 도착").
   *
   * Currently rendered by neither platform: both draw the live countdown from
   * `arrivesAt` instead (see below). It stays in the snapshot as the
   * pre-formatted fallback for a surface that cannot tick — a notification,
   * say — and because `formatEta` is where "곧 도착" is decided.
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
  /**
   * When the reading was taken, as a wall clock time ("18:31 기준"), for the
   * honesty line below. Absolute, not relative — a snapshot that says "방금
   * 기준" keeps saying it for as long as the snapshot lives. See
   * `data/busArrival.ts`.
   */
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
  | {
      status: "normal";
      /** The stop nearest the user, as the portal names it ("2번출구") — see `data/busArrival.ts`. */
      stopLabel: string;
      arrivals: BusArrival[];
    }
  | { status: "noData" };

/** Sample snapshot, matching the Figma frame's exact sample content. */
export const DEFAULT_PROPS: BusArrivalWidgetProps = {
  status: "normal",
  stopLabel: "2번출구",
  arrivals: [
    { route: "6-1", eta: "곧 도착", soon: true, arrivesAt: Date.now() + 30_000, observedLabel: "12:34 기준" },
    { route: "8", eta: "4분 19초", arrivesAt: Date.now() + 259_000, observedLabel: "12:34 기준" },
    { route: "순환41", eta: "16분 41초", arrivesAt: Date.now() + 1_001_000, observedLabel: "12:34 기준" },
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
          // A timer-style Text is flexible-width in SwiftUI — it claims the
          // room left in the row and draws its digits at the *leading* edge
          // of that room, so without this the countdown sat right next to
          // the route number instead of against the right edge.
          multilineTextAlignment("trailing"),
          font({ size: 12, weight: arrival.soon ? "medium" : "regular" }),
          foregroundStyle(
            arrival.soon ? colors.textBrand : colors.textTertiary,
          ),
        ]}
      />
    </HStack>
  );

  // Refresh. Different on each platform because the platforms differ in what
  // a widget tap can do, not by preference:
  //
  // - Android: a real in-place refresh. A `Button` with this reserved target
  //   makes expo-widgets-glance start the app's own refresh task headlessly
  //   (its HandlePressAction.REFRESH_TARGET) — no app launch.
  // - iOS: just the icon. A WidgetKit button runs in the widget extension,
  //   which has no network and can't reach the app, so it could not fetch;
  //   worse, it would steal the tap from `widgetURL`. This is a small widget,
  //   so the whole widget is one tap target that opens the app — and the app
  //   refreshes the bus widget as it comes to the foreground.
  //
  // The target string is spelled out because a widget layout can't import
  // anything; it must match GLANCE_REFRESH_TARGET in expo-widgets-glance.
  const isAndroid = (environment as { platform?: string }).platform === "android";
  const refreshIcon = (
    <Image
      assetName="RefreshIcon"
      color={colors.textTertiary}
      modifiers={[resizable(), frame({ width: 12, height: 12 })]}
    />
  );
  const refreshControl = isAndroid ? (
    // Padding widens the touch area around a 12dp icon without moving it.
    <Button target="__expo_widgets_glance_refresh" modifiers={[padding({ all: 6 })]}>
      {refreshIcon}
    </Button>
  ) : (
    refreshIcon
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
                // Stop names vary in length ("인천대입구역.롯데몰"); one line,
                // truncated, keeps the header from pushing the rows down.
                lineLimit(1),
                font({ size: 14, weight: "semibold" }),
                foregroundStyle(colors.textSecondary),
              ]}
            >
              {props.stopLabel}
            </Text>
          </HStack>
          <VStack
            spacing={8}
            alignment="leading"
            // The 16 between header and rows lives here rather than in the
            // root stack's `spacing` — see the root VStack for why.
            modifiers={[padding({ top: 16 }), frame({ maxWidth: Infinity })]}
          >
            {props.arrivals.map((arrival, index) => row(arrival, index))}
          </VStack>
          {/* How old the estimates are. Not decoration and not an apology:
              on Android the times above are frozen at the last widget update
              (Glance cannot tick), and even on iOS, where they do count down,
              the countdown is only as good as the reading it started from —
              the bus may already have been rerouted. Stating the age is the
              only way the number isn't a quiet lie. */}
          <Spacer minLength={0} />
          <HStack alignment="center" modifiers={[frame({ maxWidth: Infinity })]}>
            <Text modifiers={[font({ size: 10 }), foregroundStyle(colors.textTertiary)]}>
              {props.arrivals[0].observedLabel}
            </Text>
            <Spacer />
            {refreshControl}
          </HStack>
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
          {/* The state a refresh matters most in: every bus the widget knew
              about has arrived, and nothing new comes in until something
              fetches. */}
          <Spacer />
          <HStack modifiers={[frame({ maxWidth: Infinity })]}>
            <Spacer />
            {refreshControl}
          </HStack>
        </VStack>
      );
      break;
  }

  return (
    <VStack
      alignment="leading"
      // Zero, not 16. Stack spacing is inserted between *every* pair of
      // children, and the `normal` layout has four of them — header, rows,
      // Spacer, footer — so 16 here cost 48pt of a 170pt small widget. Adding
      // the "기준" footer took the content to ~192pt; SwiftUI centres an
      // overflowing stack and clips both ends equally, which on screen looked
      // exactly like the widget's top and bottom padding had vanished. The
      // one gap the design actually has (header → rows) is padding on the
      // rows instead.
      spacing={0}
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
registerGlanceWidget("BusArrivalWidget", BusArrivalWidget, { refreshIntervalMs: BUS_REFRESH_MS });

export default createWidget("BusArrivalWidget", BusArrivalWidget);
