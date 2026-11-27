package expo.modules.notificationrelay

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import java.lang.ref.WeakReference

/**
 * 설정된 앱(스마트캠퍼스)의 알림을 받아 키워드로 분류하고, 원본을 지운 뒤 INTIP 카테고리 채널로
 * 다시 띄운다.
 *
 * 알아 둘 것:
 * - 원본이 뜨는 순간 소리/진동이 한 번 날 수 있다(지우기 전이라서). 사용자에게 스마트캠퍼스
 *   알림을 "끄기"가 아니라 "무음"으로 바꾸게 안내한다 — 완전히 끄면 이 서비스에도 안 온다.
 * - 이 서비스는 앱 프로세스에서 돌지만 JS 런타임은 없다. 분류는 전부 여기(Kotlin)에서 한다.
 * - Android 15+는 OTP 같은 민감한 알림 내용을 일반 리스너에게 가린다. 스마트캠퍼스 공지에는
 *   해당 없을 것으로 보지만, 내용이 비어 오면 그 때문일 수 있다.
 */
class RelayListenerService : NotificationListenerService() {

  override fun onListenerConnected() {
    super.onListenerConnected()
    instance = WeakReference(this)
    Log.d(TAG, "listener connected")
  }

  override fun onListenerDisconnected() {
    super.onListenerDisconnected()
    instance = null
    Log.d(TAG, "listener disconnected")
  }

  override fun onNotificationPosted(sbn: StatusBarNotification) {
    if (sbn.packageName == packageName) return // 우리가 다시 띄운 알림
    val config = RelayConfig.load(this) ?: return
    if (!config.enabled || sbn.packageName !in config.sourcePackages) return

    val notification = sbn.notification
    if (sbn.isOngoing) return // 다운로드 진행률 같은 건 건드리지 않는다

    // 묶음 요약 알림은 내용이 없다 — 다시 띄우지 않고, 개별 알림을 다 지우면 남는 빈 묶음만 정리한다.
    if ((notification.flags and Notification.FLAG_GROUP_SUMMARY) != 0) {
      if (config.cancelOriginal) cancelQuietly(sbn.key)
      return
    }

    val extras = notification.extras
    val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
    val body = (
      extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
        ?: extras.getCharSequence(Notification.EXTRA_TEXT)
      )?.toString().orEmpty()
    if (title.isEmpty() && body.isEmpty()) return // 분류할 게 없으면 원본을 그대로 둔다

    val (category, keyword) = config.classify(title, body)
    Log.d(TAG, "classified ${sbn.key} -> ${category.id} (keyword=$keyword)")

    if (!category.drop) {
      RelayNotifier.ensureChannel(this, config, category)
      RelayNotifier.post(
        context = this,
        key = sbn.key,
        category = category,
        title = title,
        body = body,
        postedAt = sbn.postTime,
        contentIntent = notification.contentIntent,
      )
    }
    RelayNotifier.appendRecent(this, sbn.packageName, title, body, category.id, category.drop)
    if (config.cancelOriginal) cancelQuietly(sbn.key)
  }

  private fun cancelQuietly(key: String) {
    try {
      cancelNotification(key)
    } catch (e: SecurityException) {
      // 리스너 연결이 끊긴 사이에 온 콜백. 다음 연결 때 다시 처리하지는 않는다.
      Log.w(TAG, "cancelNotification failed: ${e.message}")
    }
  }

  companion object {
    private const val TAG = "NotificationRelay"

    /** 모듈의 getActiveNotificationSources()가 쓰는 현재 연결된 인스턴스. */
    @Volatile
    var instance: WeakReference<RelayListenerService>? = null
  }
}
