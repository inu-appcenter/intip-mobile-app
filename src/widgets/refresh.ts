import { Platform } from "react-native";

import { updateGlanceSnapshot } from "expo-widgets-glance";

import BusArrivalWidget, {
  DEFAULT_PROPS as BUS_ARRIVAL_DEFAULT_PROPS,
} from "./BusArrivalWidget";
import CafeteriaMenuWidget, {
  DEFAULT_PROPS as CAFETERIA_MENU_DEFAULT_PROPS,
} from "./CafeteriaMenuWidget";
import NextClassWidget, { DEFAULT_PROPS as NEXT_CLASS_DEFAULT_PROPS } from "./NextClassWidget";
import TestWidget from "./TestWidget";
import TimetableWidget, { DEFAULT_PROPS as TIMETABLE_DEFAULT_PROPS } from "./TimetableWidget";
import TodayClassesWidget, {
  DEFAULT_PROPS as TODAY_CLASSES_DEFAULT_PROPS,
} from "./TodayClassesWidget";

/**
 * Pushes a snapshot into the home screen widget.
 *
 * A widget renders whatever the last timeline entry held; with no entry it sits
 * on the placeholder the system draws at install time. `updateSnapshot` writes a
 * single entry dated now, which is all the countdown needs — the timer text
 * ticks on the WidgetKit side from there.
 *
 * expo-widgets is iOS-only. The Android build resolves to a no-op stub rather
 * than throwing, so the guard is about not doing pointless work, not safety.
 * (TestWidget itself has no Android counterpart — it's an iOS-only test bed,
 * not one of the two designed widgets — so there's no `updateGlanceSnapshot`
 * call to add here.)
 */
export function refreshTestWidget() {
  if (Platform.OS !== "ios") {
    return;
  }

  const now = Date.now();
  TestWidget.updateSnapshot({
    label: "테스트 카운트다운",
    targetAt: now + 60 * 60 * 1000,
    updatedAt: now,
  });
}

/**
 * Pushes a snapshot into the "다음 수업" home screen widget (both platforms —
 * `updateSnapshot` for iOS, `updateGlanceSnapshot` for Android, see
 * `expo-widgets-glance`'s README).
 *
 * Real timetable data isn't wired up yet, so this always pushes the same
 * `DEFAULT_PROPS` ("수업 전") snapshot — enough to confirm the widget builds
 * and renders, not a working feature. Replace the argument with whatever the
 * timetable fetch resolves to (see `NextClassWidgetProps` for the other
 * states it should be able to render) once that lands.
 */
export function refreshNextClassWidget() {
  if (Platform.OS === "ios") {
    NextClassWidget.updateSnapshot(NEXT_CLASS_DEFAULT_PROPS);
  } else if (Platform.OS === "android") {
    updateGlanceSnapshot("NextClassWidget", NEXT_CLASS_DEFAULT_PROPS);
  }
}

/**
 * Pushes a snapshot into the "오늘 수업" (today's classes) home screen widget
 * (both platforms — see `refreshNextClassWidget` above).
 *
 * Same caveat as `refreshNextClassWidget`: no real timetable fetch yet, so
 * this always pushes the sample "정상" snapshot from `DEFAULT_PROPS`.
 */
export function refreshTodayClassesWidget() {
  if (Platform.OS === "ios") {
    TodayClassesWidget.updateSnapshot(TODAY_CLASSES_DEFAULT_PROPS);
  } else if (Platform.OS === "android") {
    updateGlanceSnapshot("TodayClassesWidget", TODAY_CLASSES_DEFAULT_PROPS);
  }
}

/**
 * Pushes a snapshot into the "인입런" (bus arrival) home screen widget (both
 * platforms — see `refreshNextClassWidget` above).
 *
 * Same caveat as the others: no real bus-arrival fetch wired up yet, so
 * this always pushes the sample snapshot from `DEFAULT_PROPS`.
 */
export function refreshBusArrivalWidget() {
  if (Platform.OS === "ios") {
    BusArrivalWidget.updateSnapshot(BUS_ARRIVAL_DEFAULT_PROPS);
  } else if (Platform.OS === "android") {
    updateGlanceSnapshot("BusArrivalWidget", BUS_ARRIVAL_DEFAULT_PROPS);
  }
}

/**
 * Pushes a snapshot into the "학식 메뉴" (cafeteria menu) home screen widget
 * (both platforms — see `refreshNextClassWidget` above).
 *
 * Same caveat as the others: no real cafeteria-menu fetch wired up yet, so
 * this always pushes the sample snapshot from `DEFAULT_PROPS`.
 */
export function refreshCafeteriaMenuWidget() {
  if (Platform.OS === "ios") {
    CafeteriaMenuWidget.updateSnapshot(CAFETERIA_MENU_DEFAULT_PROPS);
  } else if (Platform.OS === "android") {
    updateGlanceSnapshot("CafeteriaMenuWidget", CAFETERIA_MENU_DEFAULT_PROPS);
  }
}

/**
 * Pushes a snapshot into the "시간표" (timetable) home screen widget (both
 * platforms — see `refreshNextClassWidget` above).
 *
 * Same caveat as the others: no real timetable fetch wired up yet, so this
 * always pushes the sample snapshot from `DEFAULT_PROPS`. See
 * `TimetableWidget.tsx`'s module doc comment for why this widget is a
 * simplified single-day list rather than the Figma frame's full week grid.
 */
export function refreshTimetableWidget() {
  if (Platform.OS === "ios") {
    TimetableWidget.updateSnapshot(TIMETABLE_DEFAULT_PROPS);
  } else if (Platform.OS === "android") {
    updateGlanceSnapshot("TimetableWidget", TIMETABLE_DEFAULT_PROPS);
  }
}
