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
 *
 * ## Why every cafeteria is fetched
 *
 * Which cafeteria a widget shows is a per-widget option the user picks on the
 * home screen (`configuration.cafeteria`, see app.json). That choice lives in
 * the widget extension only — the app process that fetches never learns it —
 * so the snapshot carries all of them and the layout picks one.
 */
import type { CafeteriaMenuWidgetProps, CafeteriaSnapshot, MenuColumn } from '../CafeteriaMenuWidget';
import { getJson } from './apiClient';

type CafeteriaOption = {
  /** The configuration enum value — a Swift enum case, so an identifier. */
  id: string;
  /**
   * The exact key `/api/cafeterias` takes. An unknown name is not an error
   * there, it just answers `[null,null,null]` — which is how "제1학생식당" left
   * the widget permanently empty.
   */
  name: string;
  /**
   * The corners this option shows, by their short title (`1코너`). A medium
   * widget fits two corners side by side, so a cafeteria with more is split
   * into several options, the way inu-portal-web's home widget splits it into
   * slides (`WIDGET_CORNER_GROUPS`). Absent: every corner.
   */
  corners?: string[];
};

/** The widget's options, in inu-portal-web's order (`resources/strings/cafeterias.tsx`). */
export const CAFETERIAS: readonly CafeteriaOption[] = [
  { id: 'student12', name: '학생식당', corners: ['1코너', '2코너'] },
  { id: 'student45', name: '학생식당', corners: ['4코너', '5코너'] },
  { id: 'staff2', name: '2호관(교직원)식당' },
  { id: 'dorm1', name: '제1기숙사식당' },
  { id: 'education', name: '사범대식당' },
  { id: 'bldg27', name: '27호관식당' },
  { id: 'dorm2', name: '2기숙사 식당' },
];

export type Meal = 'breakfast' | 'lunch' | 'dinner';

/**
 * What the menu endpoint actually returns: one slot per meal, in
 * breakfast/lunch/dinner order. A slot is `null` or `"-"` where that meal
 * isn't served.
 */
export type MenuSlots = (string | null)[];

type MealWindow = {
  meal: Meal;
  label: string;
  /** inu-portal-web's name for the meal, the column title of a menu without corners. */
  title: string;
  /** Index into {@link MenuSlots}. */
  slot: number;
  /** Minutes from midnight. */
  startMinutes: number;
  endMinutes: number;
};

/**
 * Service windows, matching the footer the Figma frame shows
 * ("11:30–14:00 운영 중"). The API carries no hours, so these are shared by
 * every cafeteria; a meal a cafeteria doesn't serve is skipped by its empty
 * slot, not by a per-cafeteria table.
 */
export const MEAL_WINDOWS: MealWindow[] = [
  { meal: 'breakfast', label: '아침', title: '조식', slot: 0, startMinutes: 8 * 60, endMinutes: 9 * 60 + 30 },
  { meal: 'lunch', label: '점심', title: '중식', slot: 1, startMinutes: 11 * 60 + 30, endMinutes: 14 * 60 },
  { meal: 'dinner', label: '저녁', title: '석식', slot: 2, startMinutes: 17 * 60 + 30, endMinutes: 19 * 60 },
];

function minutesOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

/** `"11:30"`. */
function formatTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** `"11:30–14:00"`. */
function formatWindow(window: MealWindow): string {
  return `${formatTime(window.startMinutes)}–${formatTime(window.endMinutes)}`;
}

/**
 * The meal to show right now among `windows`: the one being served, else the
 * next one today, else null once the last window has closed.
 */
export function currentMealWindow(now: Date, windows: MealWindow[] = MEAL_WINDOWS): MealWindow | null {
  const nowMinutes = minutesOfDay(now);
  return (
    windows.find((w) => nowMinutes >= w.startMinutes && nowMinutes < w.endMinutes) ??
    windows.find((w) => nowMinutes < w.startMinutes) ??
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
 * Lines a column shows under its title. A longer list gives up its last line
 * to `…`, so a cut-off menu never reads as the whole menu.
 */
const COLUMN_ROWS = 3;
const MORE = '…';

const NOT_SERVED = '-';
/** `[1코너(백반)]` on its own line, or `[선택1] 육개장` with the dish after it. */
const SECTION_HEAD = /^\[([^\]]+)\]\s*(.*)$/;
/** Pick-one meals (2호관식당): the choices and what comes with every choice. */
const CHOICE_TITLE = /^선택\d+$/;
const COMMON_TITLE = '공통';
/** Always-the-same corners, left out like inu-portal-web's home widget does. */
const FIXED_CORNERS = ['국밥'];
/** `*11:30~13:30*`, `<천원의아침밥>`. */
const NOTICE_LINE = /^(\*.*\*|<.*>)$/;
/** `6,500원 (구성원 5,500원)`, `7,500(구성원 6,500원)`. */
const PRICE_LINE = /^"?[0-9,]+\s*(원|\()/;
/** `1246kcal`, `1,103/1,310kcal`, `1153kcal 1210kcal`. */
const CALORIE_LINE = /^[0-9,\s/]*kcal/i;
/** A price and everything after it, when the server puts it all on one line. */
const PRICE_TAIL = /\s*"?[0-9,]+\s*원.*$/;

function isDish(line: string): boolean {
  return line.length > 0 && !NOTICE_LINE.test(line) && !PRICE_LINE.test(line) && !CALORIE_LINE.test(line);
}

/** `1코너(백반)` → `1코너`. */
function shortTitle(title: string): string {
  return title.replace(/\(.*\)$/, '');
}

/** At most {@link COLUMN_ROWS} lines, the last one `…` when dishes were cut. */
function fitRows(items: string[]): string[] {
  return items.length <= COLUMN_ROWS ? items : [...items.slice(0, COLUMN_ROWS - 1), MORE];
}

type Section = { title: string | null; dishes: string[] };

/** Splits a slot at its `[...]` headings. Dishes before the first heading get a null title. */
function sectionsOf(lines: string[]): Section[] {
  const sections: Section[] = [{ title: null, dishes: [] }];
  for (const line of lines) {
    const head = line.match(SECTION_HEAD);
    if (head) sections.push({ title: head[1], dishes: [] });
    const dish = (head ? head[2] : line).replace(PRICE_TAIL, '').trim();
    if (isDish(dish)) sections[sections.length - 1].dishes.push(dish);
  }
  return sections.filter((section) => section.dishes.length > 0);
}

/**
 * One meal slot's text, as the columns the widget lays side by side.
 *
 * The server sends a slot in one of three shapes (see inu-portal-web's
 * `utils/cafeteriaMenu.ts`):
 * - corners, `[1코너(백반)]\n고사리제육볶음\n…` — a column per corner, limited
 *   to `corners` when given;
 * - pick-one, `[선택1] 육개장\n[선택2] 차슈덮밥\n\n[공통]\n…` — the choices in
 *   one column and the shared dishes in the other, so the whole meal is one
 *   view;
 * - a plain list — one column titled `plainTitle`, the meal (`석식`), the way
 *   the web's menu page titles a meal without corners.
 *   Production sends this all on one line, space-separated, with the price at
 *   the end; spaces are the only separator there is, so a dish whose name has
 *   a space gets split too. Newline-separated menus don't have that problem.
 */
export function menuColumnsOf(
  text: string | null | undefined,
  corners?: string[],
  plainTitle = '메뉴',
): MenuColumn[] {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed || trimmed === NOT_SERVED) return [];

  const lines = trimmed.split('\n').map((line) => line.trim());
  const sections = sectionsOf(lines);
  const titled = sections.filter((section) => section.title !== null);

  if (titled.some((section) => CHOICE_TITLE.test(section.title!) || section.title === COMMON_TITLE)) {
    const choices = titled.filter((section) => CHOICE_TITLE.test(section.title!)).flatMap((s) => s.dishes);
    const common = titled.filter((section) => section.title === COMMON_TITLE).flatMap((s) => s.dishes);
    return [
      { title: '선택', items: fitRows(choices) },
      { title: COMMON_TITLE, items: fitRows(common) },
    ].filter((column) => column.items.length > 0);
  }

  if (titled.length > 0) {
    return titled
      .filter((section) => !FIXED_CORNERS.includes(section.title!))
      .filter((section) => !corners || corners.includes(shortTitle(section.title!)))
      .slice(0, 2)
      // The full heading, `1코너(백반)`: the kind of corner is the point of the title.
      .map((section) => ({ title: section.title!, items: fitRows(section.dishes) }));
  }

  const dishes = sections.flatMap((section) => section.dishes);
  const items = lines.length === 1 ? dishes.flatMap((dish) => dish.split(/\s+/)) : dishes;
  return items.length > 0 ? [{ title: plainTitle, items: fitRows(items) }] : [];
}

/**
 * Dishes named on the "운영 종료" card under the next meal's start time — a
 * hint at what's coming, not the menu, so it's one line and drops the `…`
 * {@link fitRows} may have put there.
 */
const PREVIEW_DISHES = 3;

function previewOf(columns: MenuColumn[]): string {
  return columns
    .flatMap((column) => column.items)
    .filter((item) => item !== MORE)
    .slice(0, PREVIEW_DISHES)
    .join(' · ');
}

/**
 * One option's snapshot at `now`, in one of the three states the Figma frames
 * spec:
 *
 * - `normal`, a meal is being served right now;
 * - `closed`, the cafeteria serves today but not at this minute — between two
 *   meals, before the first, or after the last;
 * - `notOperating`, nothing at all is posted for today (a weekend or a
 *   holiday), or the fetch failed.
 *
 * `slots` is null when its request failed. That renders as `notOperating` with
 * its own message rather than as a closed cafeteria: this is one of several
 * cafeterias in a single push, so there is no previous snapshot to keep for it
 * alone, and claiming it is shut would be a guess.
 */
export function toCafeteriaSnapshot(
  slots: MenuSlots | null,
  cafeteria: Pick<CafeteriaOption, 'name' | 'corners'>,
  now: Date,
): CafeteriaSnapshot {
  if (!slots) return { status: 'notOperating', cafeteriaName: cafeteria.name, message: '메뉴를 불러오지 못했어요' };

  const columnsAt = (window: MealWindow) => menuColumnsOf(slots[window.slot], cafeteria.corners, window.title);
  const served = MEAL_WINDOWS.filter((w) => columnsAt(w).length > 0);
  if (served.length === 0) {
    const weekend = now.getDay() === 0 || now.getDay() === 6;
    return {
      status: 'notOperating',
      cafeteriaName: cafeteria.name,
      message: weekend ? '주말에는 운영하지 않아요' : '오늘은 운영하지 않아요',
    };
  }

  const nowMinutes = minutesOfDay(now);
  const window = currentMealWindow(now, served);
  const serving = window !== null && nowMinutes >= window.startMinutes && nowMinutes < window.endMinutes;

  if (!serving) {
    // The badge Figma writes as 운영 종료 only reads right once something has
    // closed; before the day's first meal nothing has, so it says 운영 전.
    const ended = served.some((w) => nowMinutes >= w.endMinutes);
    return {
      status: 'closed',
      cafeteriaName: cafeteria.name,
      badge: ended ? '운영 종료' : '운영 전',
      // `window` is null only past the last meal — nothing left to count down to.
      nextLabel: window ? `다음 ${window.label} ${formatTime(window.startMinutes)}부터` : '오늘 운영이 끝났어요',
      preview: window ? previewOf(columnsAt(window)) : '',
    };
  }

  return {
    status: 'normal',
    cafeteriaName: cafeteria.name,
    mealLabel: window.label,
    columns: columnsAt(window),
    footer: `${formatWindow(window)} 운영 중 · 더보기`,
  };
}

/** The widget props at `now`: every option's snapshot, keyed by its id. `menus` is keyed by API name. */
export function toCafeteriaMenuProps(menus: Record<string, MenuSlots | null>, now: Date): CafeteriaMenuWidgetProps {
  const cafeterias: Record<string, CafeteriaSnapshot> = {};
  for (const option of CAFETERIAS) {
    cafeterias[option.id] = toCafeteriaSnapshot(menus[option.name] ?? null, option, now);
  }
  return { cafeterias };
}

/**
 * Today's menu for every cafeteria, keyed by API name, null for each request
 * that failed. One request per cafeteria, however many options share it.
 *
 * `day` is `Date.getDay()` (Sunday = 0), which is the convention the portal's
 * own `getCafeterias(cafeteria, day)` uses.
 */
export async function fetchCafeteriaMenus(now: Date): Promise<Record<string, MenuSlots | null>> {
  const names = [...new Set(CAFETERIAS.map((option) => option.name))];
  const entries = await Promise.all(
    names.map(
      async (name) =>
        [name, await getJson<MenuSlots>('/api/cafeterias', { query: { cafeteria: name, day: now.getDay() } })] as const,
    ),
  );
  return Object.fromEntries(entries);
}
