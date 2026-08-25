import { Image } from "expo-image";
import * as SplashScreen from "expo-splash-screen";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

import { SPLASH_BACKGROUND, SPLASH_LOGO_RATIO, SPLASH_LOGO_WIDTH } from "../theme";

// Geometry measured off the design (a 393 x 852 pt frame). Every decoration is
// placed at its intrinsic viewBox size there, so these numbers reproduce the
// mock exactly on a 393pt-wide phone and scale with the screen elsewhere.
const DESIGN_WIDTH = 393;
const HONEY = { width: 155, height: 131 };
const CHARACTER = { width: 244, height: 177, left: 130 };

// Tablets are more than twice the design width; scaling purely by width blows
// the decorations up until they crowd the logo, so cap the factor.
const MAX_SCALE = 1.7;

// How squashed the honey starts. It is anchored to the top edge, so scaling it
// up on Y reads as the drip stretching downwards rather than as a slide-in.
const HONEY_FROM_SCALE = 0.35;

// Kept short on purpose: the overlay above this can be dismissed as soon as the
// web signals it is ready, which on a warm launch is a few hundred ms. A longer
// entrance would routinely get cut off mid-drip.
const HONEY_MS = 700;
const CHARACTER_MS = 620;
const CHARACTER_DELAY_MS = 120;

/** Images that must be on screen before the system splash may be dropped. */
const ASSET_COUNT = 3;

// Never strand the user on the system splash. `onDisplay`/`onError` should
// always fire, but a decode that neither succeeds nor reports failure would
// otherwise leave the app looking hung at launch.
const HANDOFF_TIMEOUT_MS = 2000;

// Launch-once state, deliberately module-level rather than component state:
// SplashArt is mounted twice in a normal launch — first by the connectivity
// gate in `app/index.tsx`, then by the root container's reveal overlay — and
// both the hand-off and the entrance must happen exactly once across the two.
// Without this the honey visibly re-drips the moment the gate flips to online.
let systemSplashHidden = false;
let entrancePlayed = false;

/**
 * The branded launch screen, drawn in JS.
 *
 * The system splash cannot render this: Android 12+ owns its splash and only
 * accepts a single flat background *color* plus a centre icon, so the honey
 * and the character have nowhere to live there. Instead the system splash
 * shows just the background + logo, and this view continues it with the full
 * artwork — same colour, and the logo at whatever width the system splash
 * actually put on screen (see `SPLASH_LOGO_WIDTH`, which is halved on Android
 * for that reason), so the hand-off reads as one screen with the decorations
 * arriving rather than as two screens.
 *
 * That hand-off is also why only the decorations animate. The logo is the one
 * element the system splash already drew, so it has to be sitting exactly where
 * it was left; animating it would turn the seam into a visible jump.
 *
 * Decorations are SVG (expo-image renders them natively), so they stay sharp
 * at any density and on tablets.
 */
export default function SplashArt() {
  const { width } = useWindowDimensions();
  const scale = Math.min(width / DESIGN_WIDTH, MAX_SCALE);
  const reduceMotion = useReducedMotion();

  // 0 -> 1 entrance progress, one per decoration so they can be paced apart.
  // A remount after the entrance already ran (the gate handing over to the root
  // container) starts settled, so the picture does not replay itself.
  const honey = useSharedValue(entrancePlayed ? 1 : 0);
  const character = useSharedValue(entrancePlayed ? 1 : 0);

  // Drives both the hand-off and the entrance: the artwork is on screen, so
  // dropping the system splash reveals a finished picture rather than a
  // half-decoded one, and the entrance is guaranteed to play in front of the
  // user instead of behind the splash that is still covering it.
  const [drawn, setDrawn] = useState(entrancePlayed);
  const displayed = useRef(0);

  const handOff = useCallback(() => {
    if (!systemSplashHidden) {
      systemSplashHidden = true;
      void SplashScreen.hideAsync();
    }
    setDrawn(true);
  }, []);

  // `onDisplay` fires once the view has actually rendered the source; `onError`
  // stands in for it so one broken asset cannot hold the splash hostage.
  const onAssetDrawn = useCallback(() => {
    if (systemSplashHidden) return;
    displayed.current += 1;
    if (displayed.current >= ASSET_COUNT) handOff();
  }, [handOff]);

  useEffect(() => {
    if (systemSplashHidden) return;
    const timeout = setTimeout(handOff, HANDOFF_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [handOff]);

  useEffect(() => {
    if (!drawn || entrancePlayed) return;
    entrancePlayed = true;
    if (reduceMotion) {
      honey.value = 1;
      character.value = 1;
      return;
    }
    honey.value = withTiming(1, {
      duration: HONEY_MS,
      // Fast at first, settling slowly — honey running out and then thickening.
      easing: Easing.out(Easing.cubic),
    });
    character.value = withDelay(
      CHARACTER_DELAY_MS,
      withTiming(1, { duration: CHARACTER_MS, easing: Easing.out(Easing.back(1.1)) }),
    );
  }, [character, drawn, honey, reduceMotion]);

  // Both entrances are pure transforms, so they run on the UI thread and are
  // unaffected by whatever the JS thread is doing during launch (connectivity
  // check, WebView boot, FCM token fetch) — which is precisely when this shows.
  const honeyStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: HONEY_FROM_SCALE + (1 - HONEY_FROM_SCALE) * honey.value }],
  }));

  const characterStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - character.value) * CHARACTER.height * scale }],
  }));

  return (
    <View style={styles.root}>
      {/* Honey drips over the top-left corner, flush to both edges. */}
      <Animated.View
        style={[
          {
            position: "absolute",
            top: 0,
            left: 0,
            width: HONEY.width * scale,
            height: HONEY.height * scale,
            // Anchor the stretch to the screen edge the honey comes from.
            transformOrigin: "top",
          },
          honeyStyle,
        ]}
      >
        <Image
          source={require("../../assets/splash/honey.svg")}
          style={styles.fill}
          contentFit="contain"
          onDisplay={onAssetDrawn}
          onError={onAssetDrawn}
        />
      </Animated.View>

      {/* Character sits flush on the bottom edge, offset right of centre. */}
      <Animated.View
        style={[
          {
            position: "absolute",
            bottom: 0,
            left: CHARACTER.left * scale,
            width: CHARACTER.width * scale,
            height: CHARACTER.height * scale,
          },
          characterStyle,
        ]}
      >
        <Image
          source={require("../../assets/splash/character.svg")}
          style={styles.fill}
          contentFit="contain"
          onDisplay={onAssetDrawn}
          onError={onAssetDrawn}
        />
      </Animated.View>

      {/* Not scaled, not animated: must match app.json's `imageWidth` exactly.
          It is also the one asset the system splash is already showing, so the
          hand-off waits for it too — dropping the splash before it has drawn
          would blink the logo out and straight back in. */}
      <Image
        source={require("../../assets/splash/logo-splash.png")}
        style={{ width: SPLASH_LOGO_WIDTH, height: SPLASH_LOGO_WIDTH / SPLASH_LOGO_RATIO }}
        contentFit="contain"
        onDisplay={onAssetDrawn}
        onError={onAssetDrawn}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: SPLASH_BACKGROUND,
    alignItems: "center",
    justifyContent: "center",
    // Both decorations are positioned to bleed past an edge.
    overflow: "hidden",
  },
  fill: { width: "100%", height: "100%" },
});
