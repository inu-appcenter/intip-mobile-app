package expo.modules.intipsystemgestures

import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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
  }
}
