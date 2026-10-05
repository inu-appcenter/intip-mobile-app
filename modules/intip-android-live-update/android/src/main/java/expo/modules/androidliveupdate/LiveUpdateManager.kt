package expo.modules.androidliveupdate

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.util.Log

const val TAG = "IntipLiveUpdate"
const val ACTION_TICK = "expo.modules.androidliveupdate.ACTION_TICK"
private const val PREFS_NAME = "intip_live_update_prefs"

data class LiveUpdateSession(
  val id: Int,
  val channelId: String,
  val channelName: String,
  val title: String,
  val courseTitle: String?,
  val details: String?,
  val timeRange: String?,
  val locationAndProf: String?,
  val phase: String, // "UPCOMING" or "ONGOING"
  val startTimestamp: Long?,
  val endTimestamp: Long?,
  val targetTimestamp: Long?,
  val leadTimeMinutes: Int,
  val durationMinutes: Int,
  val segmentsRaw: List<Map<String, Any?>>?,
  val ongoing: Boolean
)

object LiveUpdateManager {

  @Synchronized
  fun saveSession(context: Context, session: LiveUpdateSession) {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    prefs.edit().apply {
      putInt("id", session.id)
      putString("channelId", session.channelId)
      putString("channelName", session.channelName)
      putString("title", session.title)
      putString("courseTitle", session.courseTitle)
      putString("details", session.details)
      putString("timeRange", session.timeRange)
      putString("locationAndProf", session.locationAndProf)
      putString("phase", session.phase)
      putLong("startTimestamp", session.startTimestamp ?: 0L)
      putLong("endTimestamp", session.endTimestamp ?: 0L)
      putLong("targetTimestamp", session.targetTimestamp ?: 0L)
      putInt("leadTimeMinutes", session.leadTimeMinutes)
      putInt("durationMinutes", session.durationMinutes)
      putBoolean("ongoing", session.ongoing)
      apply()
    }
  }

  @Synchronized
  fun loadSession(context: Context): LiveUpdateSession? {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val id = prefs.getInt("id", -1)
    if (id == -1) return null
    val ongoing = prefs.getBoolean("ongoing", false)
    if (!ongoing) return null

    val phase = prefs.getString("phase", "ONGOING") ?: "ONGOING"
    val segmentsColor = if (phase.equals("UPCOMING", ignoreCase = true)) "#5B8DEF" else "#043799"
    val segmentsRaw = listOf(mapOf("length" to 100, "color" to segmentsColor))

    return LiveUpdateSession(
      id = id,
      channelId = prefs.getString("channelId", "timetable_nowbar_v3") ?: "timetable_nowbar_v3",
      channelName = prefs.getString("channelName", "실시간 시간표 (나우 바)") ?: "실시간 시간표 (나우 바)",
      title = prefs.getString("title", "") ?: "",
      courseTitle = prefs.getString("courseTitle", null),
      details = prefs.getString("details", null),
      timeRange = prefs.getString("timeRange", null),
      locationAndProf = prefs.getString("locationAndProf", null),
      phase = phase,
      startTimestamp = prefs.getLong("startTimestamp", 0L).let { if (it > 0L) it else null },
      endTimestamp = prefs.getLong("endTimestamp", 0L).let { if (it > 0L) it else null },
      targetTimestamp = prefs.getLong("targetTimestamp", 0L).let { if (it > 0L) it else null },
      leadTimeMinutes = prefs.getInt("leadTimeMinutes", 15),
      durationMinutes = prefs.getInt("durationMinutes", 75),
      segmentsRaw = segmentsRaw,
      ongoing = ongoing
    )
  }

  @Synchronized
  fun clearSession(context: Context) {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    prefs.edit().clear().apply()
  }

  fun scheduleNextAlarm(context: Context, session: LiveUpdateSession) {
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    val now = System.currentTimeMillis()
    val msToNextMinute = 60_000L - (now % 60_000L)
    val triggerAtMillis = now + maxOf(500L, msToNextMinute + 100L)

    val intent = Intent(context, LiveUpdateAlarmReceiver::class.java).apply {
      action = ACTION_TICK
      putExtra("id", session.id)
    }
    val pendingIntent = PendingIntent.getBroadcast(
      context,
      session.id,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          if (alarmManager.canScheduleExactAlarms()) {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pendingIntent)
          } else {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pendingIntent)
          }
        } else {
          alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pendingIntent)
        }
      } else {
        alarmManager.setExact(AlarmManager.RTC_WAKEUP, triggerAtMillis, pendingIntent)
      }
      Log.d(TAG, "Scheduled next AlarmManager tick at $triggerAtMillis (in ${msToNextMinute / 1000}s)")
    } catch (e: Exception) {
      Log.w(TAG, "Failed to schedule AlarmManager tick", e)
    }
  }

  fun cancelAlarm(context: Context, id: Int) {
    try {
      val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
      val intent = Intent(context, LiveUpdateAlarmReceiver::class.java).apply {
        action = ACTION_TICK
        putExtra("id", id)
      }
      val pendingIntent = PendingIntent.getBroadcast(
        context,
        id,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      alarmManager.cancel(pendingIntent)
      pendingIntent.cancel()
      Log.d(TAG, "Cancelled AlarmManager tick for id=$id")
    } catch (e: Exception) {
      Log.w(TAG, "Failed to cancel AlarmManager tick", e)
    }
  }

  @Synchronized
  fun onTick(context: Context) {
    val session = loadSession(context) ?: return
    val now = System.currentTimeMillis()

    if (session.phase.equals("ONGOING", ignoreCase = true)) {
      val endMs = session.endTimestamp ?: (now + session.durationMinutes * 60_000L)
      if (now >= endMs) {
        Log.i(TAG, "Class ended (now >= $endMs), stopping LiveUpdate")
        stopLiveUpdate(context, session.id)
        return
      }

      val remainingMs = maxOf(0L, endMs - now)
      val remainingMinutes = kotlin.math.ceil(remainingMs / 60000.0).toInt()
      val remainingText = if (remainingMinutes <= 0) "곧 종료" else "${remainingMinutes}분 남음"

      val startMs = session.startTimestamp ?: (endMs - session.durationMinutes * 60_000L)
      val totalDurationMs = maxOf(60_000L, endMs - startMs)
      val elapsedMs = maxOf(0L, now - startMs)
      val progress = ((elapsedMs.toDouble() / totalDurationMs) * 100).toInt().coerceIn(0, 100)

      val courseName = session.courseTitle ?: session.title.removePrefix("[수업 중] ").trim()
      val fullTitle = "[수업 중] $courseName"
      val timePart = if (!session.timeRange.isNullOrEmpty()) " · ${session.timeRange}" else ""
      val line1 = "$remainingText$timePart"
      val line2 = session.locationAndProf ?: session.details ?: ""
      val cardBody = if (line2.isNotEmpty()) "$line1\n$line2" else line1

      buildAndPostNotification(
        context = context,
        id = session.id,
        channelId = session.channelId,
        channelName = session.channelName,
        title = fullTitle,
        text = cardBody,
        shortCriticalText = remainingText,
        progress = progress,
        segmentsRaw = session.segmentsRaw,
        ongoing = session.ongoing
      )
      scheduleNextAlarm(context, session)

    } else if (session.phase.equals("UPCOMING", ignoreCase = true)) {
      val startMs = session.startTimestamp ?: return
      if (now >= startMs) {
        // Class begins! Transition session to ONGOING
        val courseName = session.courseTitle ?: session.title.removePrefix("[다음 수업] ").trim()
        val endMs = session.endTimestamp ?: (startMs + session.durationMinutes * 60_000L)
        val ongoingSession = session.copy(
          phase = "ONGOING",
          title = "[수업 중] $courseName",
          startTimestamp = startMs,
          endTimestamp = endMs,
          segmentsRaw = listOf(mapOf("length" to 100, "color" to "#043799"))
        )
        saveSession(context, ongoingSession)
        onTick(context)
        return
      }

      val remainingMs = maxOf(0L, startMs - now)
      val remainingMinutes = kotlin.math.ceil(remainingMs / 60000.0).toInt()
      val remainingText = if (remainingMinutes <= 0 || remainingMs <= 30_000L) "곧 시작" else "${remainingMinutes}분 전"

      val totalLeadMs = maxOf(60_000L, session.leadTimeMinutes * 60_000L)
      val elapsedLeadMs = maxOf(0L, totalLeadMs - remainingMs)
      val progress = ((elapsedLeadMs.toDouble() / totalLeadMs) * 100).toInt().coerceIn(0, 100)

      val courseName = session.courseTitle ?: session.title.removePrefix("[다음 수업] ").trim()
      val fullTitle = "[다음 수업] $courseName"
      val timePart = if (!session.timeRange.isNullOrEmpty()) " · ${session.timeRange}" else ""
      val line1 = "$remainingText$timePart"
      val line2 = session.locationAndProf ?: session.details ?: ""
      val cardBody = if (line2.isNotEmpty()) "$line1\n$line2" else line1

      buildAndPostNotification(
        context = context,
        id = session.id,
        channelId = session.channelId,
        channelName = session.channelName,
        title = fullTitle,
        text = cardBody,
        shortCriticalText = remainingText,
        progress = progress,
        segmentsRaw = session.segmentsRaw,
        ongoing = session.ongoing
      )
      scheduleNextAlarm(context, session)
    }
  }

  fun stopLiveUpdate(context: Context, id: Int): Boolean {
    cancelAlarm(context, id)
    clearSession(context)
    val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    return try {
      notificationManager.cancel(id)
      Log.i(TAG, "Cancelled LiveUpdate notification id=$id")
      true
    } catch (e: Exception) {
      Log.w(TAG, "Failed to cancel LiveUpdate notification id=$id", e)
      false
    }
  }

  fun buildAndPostNotification(
    context: Context,
    id: Int,
    channelId: String,
    channelName: String,
    title: String,
    text: String,
    subText: String? = null,
    shortCriticalText: String? = null,
    progress: Int? = null,
    segmentsRaw: List<Map<String, Any?>>? = null,
    targetTimestamp: Long? = null,
    showChronometer: Boolean = false,
    showWhen: Boolean = false,
    ongoing: Boolean = true
  ): Boolean {
    val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    ensureNotificationChannel(notificationManager, channelId, channelName)

    val builder = Notification.Builder(context, channelId)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(ongoing)
      .setOnlyAlertOnce(true)
      .setAutoCancel(false)

    val iconRes = if (context.applicationInfo.icon != 0) context.applicationInfo.icon else android.R.drawable.sym_def_app_icon
    builder.setSmallIcon(iconRes)

    val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
    if (launchIntent != null) {
      val pendingIntent = PendingIntent.getActivity(
        context,
        id,
        launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      builder.setContentIntent(pendingIntent)
    }

    builder.setCategory(if (progress != null) Notification.CATEGORY_PROGRESS else Notification.CATEGORY_EVENT)

    if (!subText.isNullOrEmpty()) {
      builder.setSubText(subText)
    }

    val trimmedShortText = shortCriticalText?.take(7)
    if (!trimmedShortText.isNullOrEmpty()) {
      applyShortCriticalText(builder, trimmedShortText)
      val extras = android.os.Bundle().apply {
        putCharSequence("android.shortCriticalText", trimmedShortText)
        putString("android.shortCriticalText", trimmedShortText)
        putCharSequence("com.samsung.android.shortText", trimmedShortText)
        putCharSequence("com.samsung.android.extra.ONGOING_TEXT", trimmedShortText)
      }
      builder.addExtras(extras)
    }

    applyRequestPromotedOngoing(builder, true)

    if (showChronometer && targetTimestamp != null && targetTimestamp > 0) {
      builder.setWhen(targetTimestamp)
      builder.setUsesChronometer(true)
      try {
        Notification.Builder::class.java
          .getMethod("setChronometerCountDown", Boolean::class.javaPrimitiveType)
          .invoke(builder, true)
      } catch (_: Exception) {}
      builder.setShowWhen(showWhen)
    } else {
      builder.setUsesChronometer(false)
      builder.setShowWhen(false)
    }

    val styled = applyProgressStyle(builder, progress, segmentsRaw)
    if (!styled) {
      if (progress != null) {
        builder.setProgress(100, progress.coerceIn(0, 100), false)
      } else {
        builder.setStyle(Notification.BigTextStyle().bigText(text))
      }
    }

    val notification = builder.build()
    val promotable = checkPromotableCharacteristics(notification)
    notificationManager.notify(id, notification)
    dismissDuplicateFCMNotificationIfNeeded(notificationManager)
    return promotable ?: false
  }

  fun dismissDuplicateFCMNotificationIfNeeded(notificationManager: NotificationManager) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val active = notificationManager.activeNotifications
        for (sbn in active) {
          if (sbn.id == 1001) continue // Skip our own LiveUpdate notification
          val notif = sbn.notification ?: continue
          val notifTitle = notif.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
          val notifText = notif.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""
          if (notifTitle.contains("수업이 시작돼요") || notifText.contains("수업이 시작돼요") ||
              notifTitle.contains("수업 시작") || notifText.contains("수업 시작")) {
            Log.i(TAG, "Dismissing duplicate FCM notification: id=${sbn.id}, tag=${sbn.tag}, title=$notifTitle")
            if (sbn.tag != null) {
              notificationManager.cancel(sbn.tag, sbn.id)
            } else {
              notificationManager.cancel(sbn.id)
            }
          }
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to dismiss duplicate FCM notification", e)
    }
  }

  fun isLiveUpdateSupported(): Boolean {
    return Build.VERSION.SDK_INT >= 36 || Build.VERSION.CODENAME == "Baklava"
  }

  fun canPostPromotedNotifications(notificationManager: NotificationManager): Boolean {
    if (!isLiveUpdateSupported()) return false
    return try {
      val method = notificationManager.javaClass.getMethod("canPostPromotedNotifications")
      (method.invoke(notificationManager) as? Boolean) ?: true
    } catch (_: Exception) {
      true
    }
  }

  private fun ensureNotificationChannel(notificationManager: NotificationManager, channelId: String, channelName: String) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        notificationManager.deleteNotificationChannel("timetable_nowbar")
        notificationManager.deleteNotificationChannel("timetable_nowbar_v2")
      } catch (_: Exception) {}

      val existing = notificationManager.getNotificationChannel(channelId)
      if (existing == null) {
        val channel = NotificationChannel(
          channelId,
          channelName,
          NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
          description = "Now Bar 실시간 라이브 업데이트 알림"
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
          enableVibration(true)
          setShowBadge(false)
        }
        notificationManager.createNotificationChannel(channel)
      }
    }
  }

  private fun applyShortCriticalText(builder: Notification.Builder, text: String) {
    var applied = false
    try {
      val method = Notification.Builder::class.java.getMethod("setShortCriticalText", CharSequence::class.java)
      method.invoke(builder, text)
      applied = true
    } catch (_: Exception) {}

    if (!applied) {
      try {
        val method = Notification.Builder::class.java.getMethod("setShortCriticalText", String::class.java)
        method.invoke(builder, text)
        applied = true
      } catch (_: Exception) {}
    }
  }

  private fun applyRequestPromotedOngoing(builder: Notification.Builder, promoted: Boolean) {
    try {
      val method = Notification.Builder::class.java.getMethod(
        "setRequestPromotedOngoing",
        Boolean::class.javaPrimitiveType
      )
      method.invoke(builder, promoted)
    } catch (e: Exception) {
      Log.d(TAG, "setRequestPromotedOngoing not available on this API level")
    }
  }

  private fun applyProgressStyle(
    builder: Notification.Builder,
    progress: Int?,
    segmentsRaw: List<Map<String, Any?>>?
  ): Boolean {
    if (progress == null && segmentsRaw.isNullOrEmpty()) {
      return false
    }
    try {
      val progressStyleClass = Class.forName("android.app.Notification\$ProgressStyle")
      val progressStyle = progressStyleClass.getConstructor().newInstance()

      if (!segmentsRaw.isNullOrEmpty()) {
        val segmentClass = Class.forName("android.app.Notification\$ProgressStyle\$Segment")
        val segmentList = ArrayList<Any>()

        for (seg in segmentsRaw) {
          val length = (seg["length"] as? Number)?.toInt() ?: 100
          val segmentInstance = segmentClass.getConstructor(Int::class.javaPrimitiveType).newInstance(length)
          val colorHex = seg["color"] as? String
          if (!colorHex.isNullOrBlank()) {
            try {
              val colorInt = Color.parseColor(colorHex)
              segmentClass.getMethod("setColor", Int::class.javaPrimitiveType).invoke(segmentInstance, colorInt)
            } catch (_: Exception) {}
          }
          segmentList.add(segmentInstance)
        }

        if (segmentList.isNotEmpty()) {
          progressStyleClass.getMethod("setProgressSegments", List::class.java).invoke(progressStyle, segmentList)
        }
      }

      if (progress != null) {
        progressStyleClass.getMethod("setProgress", Int::class.javaPrimitiveType)
          .invoke(progressStyle, progress.coerceIn(0, 100))
      }

      builder.setStyle(progressStyle as Notification.Style)
      return true
    } catch (e: Exception) {
      Log.d(TAG, "Notification.ProgressStyle not supported on this platform: ${e.message}")
      return false
    }
  }

  private fun checkPromotableCharacteristics(notification: Notification): Boolean? {
    return try {
      val method = notification.javaClass.getMethod("hasPromotableCharacteristics")
      method.invoke(notification) as? Boolean
    } catch (_: Exception) {
      null
    }
  }
}
