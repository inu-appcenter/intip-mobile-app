/**
 * The JS half of Android's refresh-on-display (see `WidgetRefreshTask.kt` in
 * expo-widgets-glance).
 *
 * When a widget is about to be drawn and its snapshot has gone stale, the
 * Glance renderer starts the app's JS — booting it if the app isn't running —
 * and calls the handler registered here with the widget's name. It runs the
 * same `refresh*` functions the app runs on foreground, so a widget updated
 * while nobody has the app open is updated by exactly the code path that was
 * tested with the app open.
 *
 * iOS needs none of this: WidgetKit is handed future-dated timeline entries
 * and walks them on its own clock with no app process at all (see
 * `refresh.ts`). This file is the Android answer to the same question.
 *
 * Imported for its side effect from `index.js` — the app's entry — because the
 * registration has to exist by the time the bundle finishes evaluating. See
 * `registerGlanceRefreshTask`'s doc.
 */
import { registerGlanceRefreshTask } from 'expo-widgets-glance';

import {
  refreshBusArrivalWidget,
  refreshCafeteriaMenuWidget,
  refreshScheduleWidgets,
} from './refresh';

/**
 * Which refresh a widget name asks for.
 *
 * The three timetable widgets share one entry deliberately: they read the same
 * timetable, and `refreshScheduleWidgets` fetches it once and pushes all three
 * (see its doc). A refresh started by any one of them therefore also fixes the
 * other two, which is both cheaper and the only way they can't disagree.
 */
const REFRESHERS: Record<string, (now?: Date) => Promise<void>> = {
  NextClassWidget: refreshScheduleWidgets,
  TodayClassesWidget: refreshScheduleWidgets,
  TimetableWidget: refreshScheduleWidgets,
  BusArrivalWidget: refreshBusArrivalWidget,
  CafeteriaMenuWidget: refreshCafeteriaMenuWidget,
};

registerGlanceRefreshTask(async (widgetName) => {
  const refresh = REFRESHERS[widgetName];
  if (!refresh) {
    // Not a crash: a widget can be left on a home screen after the app stops
    // shipping it, and a task that throws would be retried by React Native.
    console.warn(`[widgets] No refresher registered for '${widgetName}'`);
    return;
  }
  await refresh();
});
