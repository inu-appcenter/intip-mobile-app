/**
 * The device's position, for widgets that depend on where the user is.
 *
 * A widget refresh runs unattended — on app background, on a foreground poll,
 * or headlessly from Android's refresh task — so this never *asks* for
 * permission: an OS dialog popping up with no screen that explains it is worse
 * than a widget that falls back to a default. Permission is granted through the
 * app's own flows (the portal's campus map, see `native/permissions.ts`), and
 * this only reads what is already allowed.
 *
 * The last good fix is cached. Android's headless refresh has no foreground
 * location access, and iOS may refuse a fix while the app is backgrounding —
 * both would otherwise make the widget jump back to its default stop every
 * time it refreshes out of sight. Where the user last opened the app is a far
 * better guess than a hardcoded stop.
 */
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';

export type Coordinate = { latitude: number; longitude: number };

const CACHE_KEY = 'intip_widget_last_position';

/** A fix this recent is reused rather than waiting on a new one. */
const LAST_KNOWN_MAX_AGE_MS = 5 * 60 * 1000;

/** How long a refresh waits for a fresh fix before settling for the cache. */
const CURRENT_POSITION_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function readCache(): Promise<Coordinate | null> {
  try {
    const raw = await SecureStore.getItemAsync(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Coordinate>;
    return typeof parsed.latitude === 'number' && typeof parsed.longitude === 'number'
      ? { latitude: parsed.latitude, longitude: parsed.longitude }
      : null;
  } catch {
    return null;
  }
}

async function readDevice(): Promise<Coordinate | null> {
  const { granted } = await Location.getForegroundPermissionsAsync();
  if (!granted) return null;

  const lastKnown = await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS });
  const fix =
    lastKnown ??
    (await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      CURRENT_POSITION_TIMEOUT_MS,
    ));
  return fix ? { latitude: fix.coords.latitude, longitude: fix.coords.longitude } : null;
}

/**
 * The best available position, or null when there has never been one.
 *
 * Never throws and never prompts — see the module doc.
 */
export async function getWidgetPosition(): Promise<Coordinate | null> {
  try {
    const position = await readDevice();
    if (position) {
      await SecureStore.setItemAsync(CACHE_KEY, JSON.stringify(position)).catch(() => undefined);
      return position;
    }
  } catch (err) {
    console.warn('[widgets/location] position unavailable', err);
  }
  return readCache();
}
