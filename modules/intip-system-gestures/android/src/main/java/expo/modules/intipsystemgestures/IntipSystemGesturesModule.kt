package expo.modules.intipsystemgestures

import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Reports the width of the band along each screen edge that the system reserves
 * for its own gestures.
 *
 * The back gesture starts inside that band, and the WebView has no idea it
 * exists — it will happily start a long press on a touch the user meant as
 * "go back". The shell guards against that, but only if it knows how wide the
 * band actually is, and that is not a constant we can hardcode:
 *
 *  - AOSP reserves 20dp, One UI reserves 30dp, and Samsung lets the user widen
 *    it further with a back-gesture sensitivity slider;
 *  - under *button* navigation the band is 0 — there is no edge gesture at all,
 *    so a hardcoded guard would cost those users a strip of screen for nothing.
 *
 * `systemGestures` is the right inset here rather than
 * `mandatorySystemGestures`: the latter is only the part an app can never take
 * back (the home indicator), while the former is the whole area the system
 * watches, which is what actually races the WebView for the touch.
 *
 * Reading is synchronous and cheap, so there is no event stream and no
 * `OnApplyWindowInsetsListener` — installing one on the decor view would fight
 * react-native-safe-area-context and the edge-to-edge setup for the same
 * callback. The JS side re-reads instead, which is enough: the band only
 * changes when the user visits Settings, and the app passes through background
 * on the way.
 */
class IntipSystemGesturesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("IntipSystemGestures")

    // dp, not px: the caller compares this against gesture-handler hitSlop and
    // against CSS pixels inside the WebView, both of which are density units.
    Function("getGestureInsets") {
      val activity = appContext.currentActivity
      val view = activity?.window?.decorView
      val insets = view?.let { ViewCompat.getRootWindowInsets(it) }
        ?.getInsets(WindowInsetsCompat.Type.systemGestures())
      val density = activity?.resources?.displayMetrics?.density ?: 1f

      // `null` means "could not read", which the JS side must not confuse with
      // a genuine zero (button navigation). It falls back to a constant there.
      if (insets == null || density <= 0f) {
        return@Function null
      }

      mapOf(
        "left" to insets.left / density,
        "right" to insets.right / density,
        "top" to insets.top / density,
        "bottom" to insets.bottom / density
      )
    }
  }
}
