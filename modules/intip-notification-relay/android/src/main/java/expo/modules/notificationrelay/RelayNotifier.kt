package expo.modules.notificationrelay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * 분류된 알림을 INTIP 알림으로 다시 띄운다. 카테고리마다 알림 채널을 하나씩 두므로, 사용자는
 * 시스템 설정에서 "스마트캠퍼스 · 행사"만 무음으로 하는 식으로 카테고리별 조절을 할 수 있다.
 *
 * notifee가 아니라 플랫폼 API를 직접 쓰는 이유: 리스너 서비스는 JS 런타임 없이 돈다.
 */
object RelayNotifier {
  private const val TAG = "NotificationRelay"
  private const val CHANNEL_PREFIX = "intip_relay_"
  private const val CHANNEL_GROUP = "intip_relay"
  private const val NOTIFICATION_TAG = "intip_relay"
  private const val KEY_RECENT = "recent"
  private const val MAX_RECENT = 30

  fun channelId(category: RelayCategory) = CHANNEL_PREFIX + category.id

  /**
   * 설정의 카테고리와 채널을 맞춘다. 없어진 카테고리의 채널은 지운다(같은 id로 다시 만들면
   * 시스템이 사용자가 바꿔 둔 채널 설정을 복원하는데, 그건 오히려 바라는 동작이다).
   */
  fun syncChannels(context: Context, config: RelayConfig) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(NotificationManager::class.java) ?: return
    nm.createNotificationChannelGroup(NotificationChannelGroup(CHANNEL_GROUP, "스마트캠퍼스 알림 분류"))
    val wanted = config.allCategories.associateBy { channelId(it) }
    for ((id, category) in wanted) {
      if (category.drop) continue
      val channel = NotificationChannel(id, category.name, importanceOf(category.importance)).apply {
        group = CHANNEL_GROUP
        description = "스마트캠퍼스 알림 중 '${category.name}'으로 분류된 알림"
      }
      // 이미 있는 채널이면 이름/설명만 바뀌고 중요도는 사용자가 정한 값이 유지된다.
      nm.createNotificationChannel(channel)
    }
    nm.notificationChannels
      .filter { it.id.startsWith(CHANNEL_PREFIX) && (wanted[it.id]?.drop ?: true) }
      .forEach { nm.deleteNotificationChannel(it.id) }
  }

  /** 채널이 지워져 있으면(앱 데이터 일부 초기화 등) 다시 맞춘다. 평소에는 조회 한 번으로 끝난다. */
  fun ensureChannel(context: Context, config: RelayConfig, category: RelayCategory) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(NotificationManager::class.java) ?: return
    if (nm.getNotificationChannel(channelId(category)) == null) syncChannels(context, config)
  }

  private fun importanceOf(value: String) = when (value) {
    "high" -> NotificationManager.IMPORTANCE_HIGH
    "low" -> NotificationManager.IMPORTANCE_LOW
    else -> NotificationManager.IMPORTANCE_DEFAULT
  }

  /**
   * @param key 원본 StatusBarNotification.key — 원본이 갱신되면 사본도 같은 id로 덮어쓴다.
   * @param contentIntent 원본의 탭 동작. 그대로 달아 두면 탭했을 때 스마트캠퍼스의 해당 화면이 열린다.
   *   PendingIntent는 만든 앱(스마트캠퍼스) 권한으로 실행되므로 다른 앱 것을 달아도 된다.
   *   TODO(실기기 확인): Android 14+ 백그라운드 액티비티 실행 제한에서 알림 탭으로 보내는 경우는
   *   허용되지만, OEM별로 실제 동작을 확인할 것.
   */
  fun post(
    context: Context,
    key: String,
    category: RelayCategory,
    title: String,
    body: String,
    postedAt: Long,
    contentIntent: PendingIntent?,
  ) {
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (!nm.areNotificationsEnabled()) {
      Log.w(TAG, "INTIP notifications are disabled; dropping relayed notification")
      return
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, channelId(category))
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context)
    }
    val iconRes = if (context.applicationInfo.icon != 0) context.applicationInfo.icon else android.R.drawable.sym_def_app_icon
    builder
      .setSmallIcon(iconRes)
      .setContentTitle("[${category.name}] $title")
      .setContentText(body)
      .setStyle(Notification.BigTextStyle().bigText(body))
      .setSubText("스마트캠퍼스")
      .setWhen(postedAt)
      .setShowWhen(true)
      .setAutoCancel(true)
      // 같은 카테고리끼리 묶는다(Android 7+ 자동 번들링).
      .setGroup(CHANNEL_PREFIX + category.id)
    contentIntent?.let { builder.setContentIntent(it) }
    nm.notify(NOTIFICATION_TAG, key.hashCode(), builder.build())
  }

  // ---- 최근 분류 내역 (기기 안에만 저장, 설정 화면 미리보기/디버깅용) ----

  fun appendRecent(
    context: Context,
    source: String,
    title: String,
    body: String,
    categoryId: String,
    dropped: Boolean,
  ) {
    val prefs = RelayConfig.prefs(context)
    val current = try {
      JSONArray(prefs.getString(KEY_RECENT, "[]"))
    } catch (e: Exception) {
      JSONArray()
    }
    val next = JSONArray()
    next.put(
      JSONObject()
        .put("at", System.currentTimeMillis())
        .put("source", source)
        .put("title", title)
        .put("body", body)
        .put("categoryId", categoryId)
        .put("dropped", dropped),
    )
    for (i in 0 until minOf(current.length(), MAX_RECENT - 1)) next.put(current.get(i))
    prefs.edit().putString(KEY_RECENT, next.toString()).apply()
  }

  fun readRecent(context: Context): String =
    RelayConfig.prefs(context).getString(KEY_RECENT, "[]") ?: "[]"

  fun clearRecent(context: Context) {
    RelayConfig.prefs(context).edit().remove(KEY_RECENT).apply()
  }
}
