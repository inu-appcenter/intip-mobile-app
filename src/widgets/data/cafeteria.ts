/**
 * Cafeteria menu data for the 학식 메뉴 widget.
 *
 * Unauthenticated, like the bus endpoints — the menu is public, so this widget
 * works on a device nobody has logged into.
 *
 * The only thing that moves during a day is *which meal* is current, and the
 * boundaries are fixed and known in advance. So this needs one fetch a day:
 * the caller can render every meal's snapshot up front and let the platform
 * switch between them at the boundary times (`mealBoundariesOf` exists for
 * exactly that). No repeated polling, on either platform.
 */
import type { CafeteriaMenuWidgetProps } from '../CafeteriaMenuWidget';
import { getJson } from './apiClient';

/** The cafeteria the widget shows. The portal keys these by Korean name. */
export const DEFAULT_CAFETERIA = '제1학생식당';

export type Meal = 'breakfast' | 'lunch' | 'dinner';

/**
 * What the menu endpoint actually returns: a slot per meal, `null` where
 * nothing is served. Typing it as `string[]` is what let the null case
 * through to a `.trim()` call — see `toCafeteriaMenuProps`.
 */
export type MenuItems = (string | null)[];

type MealWindow = {
  meal: Meal;
  label: string;
  /** Minutes from midnight. */
  startMinutes: number;
  endMinutes: number;
};

/**
 * Service windows, matching the footer the Figma frame shows
 * ("11:30–14:00 운영 중"). Breakfast is deliberately absent for 제1학생식당 —
 * inu-portal-web only treats 제1기숙사식당 as having one.
 */
export const MEAL_WINDOWS: MealWindow[] = [
  { meal: 'lunch', label: '점심', startMinutes: 11 * 60 + 30, endMinutes: 14 * 60 },
  { meal: 'dinner', label: '저녁', startMinutes: 17 * 60 + 30, endMinutes: 19 * 60 },
];

function minutesOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

/** `"11:30–14:00"`. */
function formatWindow(window: MealWindow): string {
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${hhmm(window.startMinutes)}–${hhmm(window.endMinutes)}`;
}

/**
 * The meal to show right now: the one being served, else the next one today,
 * else null once the last window has closed.
 */
export function currentMealWindow(now: Date): MealWindow | null {
  const nowMinutes = minutesOfDay(now);
  return (
    MEAL_WINDOWS.find((w) => nowMinutes >= w.startMinutes && nowMinutes < w.endMinutes) ??
    MEAL_WINDOWS.find((w) => nowMinutes < w.startMinutes) ??
    null
  );
}

/**
 * The instants today at which the displayed meal changes.
 *
 * A caller that can schedule future work — an iOS timeline, an Android
 * one-shot — uses these to hand the widget its whole day at once instead of
 * waking up to poll. Only boundaries still ahead of `now` are returned.
 */
export function mealBoundariesOf(now: Date): Date[] {
  const boundaries: Date[] = [];
  for (const window of MEAL_WINDOWS) {
    for (const minutes of [window.startMinutes, window.endMinutes]) {
      const at = new Date(now);
      at.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      if (at.getTime() > now.getTime()) boundaries.push(at);
    }
  }
  return boundaries.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Builds the widget snapshot.
 *
 * The API returns the day's menu as a flat list of strings; empty or
 * whitespace-only entries are dropped, since the upstream data regularly has
 * them and a bullet with nothing after it looks like a bug.
 */
export function toCafeteriaMenuProps(
  items: MenuItems | null,
  cafeteriaName: string,
  now: Date,
): CafeteriaMenuWidgetProps {
  const window = currentMealWindow(now);
  // `typeof === 'string'` before `.trim()`, not just a truthiness check: the
  // API sends a fixed-length slot array and fills the unserved slots with
  // `null` — a day with no menu comes back as `{"data":[null,null,null]}`,
  // not as an empty array. Calling `.trim()` on those threw, and because
  // `refreshAllWidgets` runs on `Promise.allSettled` the rejection went
  // nowhere: the widget just quietly kept showing the previous meal. Seen on
  // a real device still displaying lunch at 20:39.
  const menu = (items ?? [])
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (!window || menu.length === 0) return { status: 'noMenu', cafeteriaName };

  const nowMinutes = minutesOfDay(now);
  const serving = nowMinutes >= window.startMinutes && nowMinutes < window.endMinutes;

  return {
    status: 'normal',
    cafeteriaName,
    mealLabel: window.label,
    // Three lines is what the medium frame has room for.
    items: menu.slice(0, 3),
    footer: `${formatWindow(window)} ${serving ? '운영 중' : '운영 예정'} · 더보기`,
  };
}

/**
 * Today's menu for one cafeteria, or null if the request failed.
 *
 * `day` is `Date.getDay()` (Sunday = 0), which is the convention the portal's
 * own `getCafeterias(cafeteria, day)` uses.
 */
export async function fetchCafeteriaMenu(
  cafeteria: string,
  now: Date,
): Promise<MenuItems | null> {
  return getJson<MenuItems>('/api/cafeterias', {
    query: { cafeteria, day: now.getDay() },
  });
}
