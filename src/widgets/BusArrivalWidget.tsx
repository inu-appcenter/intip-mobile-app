import { HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  containerBackground,
  font,
  foregroundStyle,
  frame,
  padding,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";
import { registerGlanceWidget } from "expo-widgets-glance";

/** One bus route's next arrival. */
type BusArrival = {
  route: string;
  /** Already formatted ("4분 19초", "곧 도착", "정보 없음") — no live countdown here. */
  eta: string;
  /** The design's one emphasized case ("곧 도착") gets the brand color instead of tertiary. */
  soon?: boolean;
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
    { route: "6-1", eta: "곧 도착", soon: true },
    { route: "8", eta: "4분 19초" },
    { route: "순환41", eta: "16분 41초" },
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
  const RED_BUS_NUMBERS = ["1301", "3002", "303-1", "6405", "M6405", "M6464", "6724", "6777"];
  const busColor = (route: string): string => {
    if (route.startsWith("순환") || ["41", "42", "43", "46", "47"].includes(route)) {
      return "#2C9B37";
    }
    if (route.startsWith("M") || RED_BUS_NUMBERS.includes(route)) {
      return "#D64A3A";
    }
    return "#1B4E9B";
  };

  // The route icon is the SF Symbol "bus.fill", tinted per-route the same
  // way inu-portal-web's own `BusIcon` does — `Image`'s `systemName` resolves
  // natively on iOS; expo-widgets-glance maps this one specific symbol to a
  // bundled Android vector drawable (see GlanceTreeRenderer.kt's
  // `SfSymbolDrawables`) since there's no SF Symbol catalog on Android to
  // draw from generally.
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
          systemName="bus.fill"
          size={16}
          color={busColor(arrival.route)}
          // The drawable this maps to on Android (ic_widget_bus.xml) is a
          // fixed 24dp asset — an explicit frame keeps it the same visual
          // size as iOS's `size`-driven SF Symbol rendering instead of
          // showing up oversized there.
          modifiers={[frame({ width: 16, height: 16 })]}
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
      <Text
        modifiers={[
          font({ size: 12, weight: arrival.soon ? "medium" : "regular" }),
          foregroundStyle(
            arrival.soon ? colors.textBrand : colors.textTertiary,
          ),
        ]}
      >
        {arrival.eta}
      </Text>
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
        </>
      );
      break;
    case "noData":
      content = (
        <VStack
          alignment="leading"
          spacing={4}
          modifiers={[frame({ maxHeight: Infinity })]}
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
        frame({ maxHeight: Infinity }),
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
