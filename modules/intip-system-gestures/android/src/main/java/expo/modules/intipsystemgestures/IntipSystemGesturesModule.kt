package expo.modules.intipsystemgestures

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** 시스템 제스처 영역의 가장자리별 인셋을 dp로 제공한다. */
class IntipSystemGesturesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("IntipSystemGestures")

    // 호출부와 같은 dp 단위로 반환한다.
    Function("getGestureInsets") {
      val activity = appContext.currentActivity
      val view = activity?.window?.decorView
      val insets = view?.let { ViewCompat.getRootWindowInsets(it) }
        ?.getInsets(WindowInsetsCompat.Type.systemGestures())
      val density = activity?.resources?.displayMetrics?.density ?: 1f

      // null은 측정 실패이며, 버튼 내비게이션의 0과 구분한다.
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

    // 백 제스처 영역에서 시작한 터치 동안 웹뷰의 롱프레스 햅틱을 끈다.
    // Chromium은 백 제스처로 시스템이 가져간 터치를 롱프레스로 보고
    // performHapticFeedback(LONG_PRESS)를 부르는데, 뷰 단위 설정이 꺼져 있으면
    // 무시된다. touchstart preventDefault로도 막히지만 그러면 영역에서
    // 시작한 스크롤까지 죽는다.
    AsyncFunction("setWebViewHapticsEnabled") { enabled: Boolean ->
      val root = appContext.currentActivity?.window?.decorView ?: return@AsyncFunction
      forEachWebView(root) { it.isHapticFeedbackEnabled = enabled }
    }.runOnQueue(Queues.MAIN)
  }

  private fun forEachWebView(view: View, action: (WebView) -> Unit) {
    if (view is WebView) {
      action(view)
      return
    }
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) forEachWebView(view.getChildAt(i), action)
    }
  }
}
