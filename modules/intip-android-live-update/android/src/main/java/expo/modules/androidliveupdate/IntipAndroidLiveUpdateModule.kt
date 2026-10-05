package expo.modules.androidliveupdate

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val TAG = "IntipLiveUpdate"

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

class IntipAndroidLiveUpdateModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context is unavailable")

  private val notificationManager: NotificationManager
    get() = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private val mainHandler = Handler(Looper.getMainLooper())
  private var currentSession: LiveUpdateSession? = null
  private var isReceiverRegistered = false

  private val tickRunnable = Runnable {
    updateNotificationFromTick()
    scheduleNextMinuteTick()
  }

  private val screenAndTickReceiver = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context?, intent: Intent?) {
      when (intent?.action) {
        Intent.ACTION_SCREEN_ON,
        Intent.ACTION_USER_PRESENT,
        Intent.ACTION_TIME_TICK -> {
          updateNotificationFromTick()
          scheduleNextMinuteTick()
        }
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("IntipAndroidLiveUpdate")

    OnDestroy {
      stopTicker()
    }

    /**
     * 현재 기기가 Android 16 (API 36+) Live Update Notification 및
     * Samsung One UI 8 Now Bar 승격 API를 지원하는지 확인
     */
    Function("isSupported") {
      isLiveUpdateSupported()
    }

    /**
     * 사용자가 앱의 승격 알림(Live Update) 표시를 허용했는지 확인
     */
    Function("canPostPromoted") {
      canPostPromotedNotifications()
    }

    /**
     * Live Update 알림 생성 또는 갱신
     */
    Function("startOrUpdateLiveUpdate") { options: Map<String, Any?> ->
      try {
        val id = (options["id"] as? Number)?.toInt() ?: 1001
        val channelId = options["channelId"] as? String ?: "timetable_nowbar_v3"
        val channelName = options["channelName"] as? String ?: "실시간 시간표 (나우 바)"
        val title = options["title"] as? String ?: ""
        val text = options["text"] as? String ?: ""
        val shortCriticalText = (options["shortCriticalText"] as? String)?.take(7)
        val progress = (options["progress"] as? Number)?.toInt()
        val segmentsRaw = options["segments"] as? List<Map<String, Any?>>
        val targetTimestamp = (options["targetTimestamp"] as? Number)?.toLong()
        val startTimestamp = (options["startTimestamp"] as? Number)?.toLong()
        val endTimestamp = (options["endTimestamp"] as? Number)?.toLong() ?: targetTimestamp
        val durationMinutes = (options["durationMinutes"] as? Number)?.toInt() ?: 75
        val leadTimeMinutes = (options["leadTimeMinutes"] as? Number)?.toInt() ?: 15
        val phase = (options["phase"] as? String) ?: (if (title.contains("[다음 수업]")) "UPCOMING" else "ONGOING")
        val courseTitle = options["courseTitle"] as? String
        val details = options["details"] as? String
        val timeRange = options["timeRange"] as? String
        val locationAndProf = options["locationAndProf"] as? String
        val subText = options["subText"] as? String
        val showChronometer = options["showChronometer"] as? Boolean ?: false
        val showWhen = options["showWhen"] as? Boolean ?: false
        val ongoing = options["ongoing"] as? Boolean ?: true

        // 1. 초기 알림 빌드 및 포스팅
        val promotable = buildAndPostNotification(
          id = id,
          channelId = channelId,
          channelName = channelName,
          title = title,
          text = text,
          subText = subText,
          shortCriticalText = shortCriticalText,
          progress = progress,
          segmentsRaw = segmentsRaw,
          targetTimestamp = targetTimestamp,
          showChronometer = showChronometer,
          showWhen = showWhen,
          ongoing = ongoing
        )

        // 2. 백그라운드 실시간 1분 타이머 세션 등록 및 가동
        if (ongoing && (phase == "ONGOING" || phase == "UPCOMING")) {
          currentSession = LiveUpdateSession(
            id = id,
            channelId = channelId,
            channelName = channelName,
            title = title,
            courseTitle = courseTitle,
            details = details,
            timeRange = timeRange,
            locationAndProf = locationAndProf,
            phase = phase,
            startTimestamp = startTimestamp,
            endTimestamp = endTimestamp,
            targetTimestamp = targetTimestamp,
            leadTimeMinutes = leadTimeMinutes,
            durationMinutes = durationMinutes,
            segmentsRaw = segmentsRaw,
            ongoing = ongoing
          )
          startTicker()
        } else {
          stopTicker()
          currentSession = null
        }

        mapOf(
          "success" to true,
          "promotable" to (promotable ?: false),
          "isSupported" to isLiveUpdateSupported()
        )
      } catch (e: Exception) {
        Log.e(TAG, "Failed to post LiveUpdate notification", e)
        mapOf(
          "success" to false,
          "error" to (e.message ?: "Unknown error")
        )
      }
    }

    /**
     * Live Update 알림 취소/종료
     */
    Function("stopLiveUpdate") { id: Int ->
      stopLiveUpdateInternal(id)
    }

    /**
     * 시스템의 실시간 알림(Live Update / Promotion) 설정 화면으로 직접 이동
     */
    Function("openPromotionSettings") {
      try {
        val intent = if (Build.VERSION.SDK_INT >= 36) {
          Intent("android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS").apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
          }
        } else {
          Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
          }
        }
        context.startActivity(intent)
        true
      } catch (e: Exception) {
        try {
          val fallbackIntent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
          }
          context.startActivity(fallbackIntent)
          true
        } catch (_: Exception) {
          false
        }
      }
    }
  }

  private fun buildAndPostNotification(
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
  ): Boolean? {
    ensureNotificationChannel(channelId, channelName)

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
    dismissDuplicateFCMNotificationIfNeeded()
    return promotable
  }

  private fun dismissDuplicateFCMNotificationIfNeeded() {
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

  @Synchronized
  private fun updateNotificationFromTick() {
    val session = currentSession ?: return
    val now = System.currentTimeMillis()

    if (session.phase.equals("ONGOING", ignoreCase = true)) {
      val endMs = session.endTimestamp ?: (now + session.durationMinutes * 60_000L)
      if (now >= endMs) {
        Log.i(TAG, "Class ended (now >= $endMs), stopping LiveUpdate")
        stopLiveUpdateInternal(session.id)
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
        currentSession = ongoingSession
        updateNotificationFromTick()
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
    }
  }

  private fun startTicker() {
    registerReceiverIfNeeded()
    scheduleNextMinuteTick()
  }

  private fun stopTicker() {
    mainHandler.removeCallbacks(tickRunnable)
    unregisterReceiverIfNeeded()
  }

  private fun scheduleNextMinuteTick() {
    mainHandler.removeCallbacks(tickRunnable)
    if (currentSession == null) return
    val now = System.currentTimeMillis()
    val msToNextMinute = 60_000L - (now % 60_000L)
    mainHandler.postDelayed(tickRunnable, maxOf(500L, msToNextMinute + 100L))
  }

  @Synchronized
  private fun registerReceiverIfNeeded() {
    if (isReceiverRegistered) return
    try {
      val filter = IntentFilter().apply {
        addAction(Intent.ACTION_SCREEN_ON)
        addAction(Intent.ACTION_USER_PRESENT)
        addAction(Intent.ACTION_TIME_TICK)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.registerReceiver(screenAndTickReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        context.registerReceiver(screenAndTickReceiver, filter)
      }
      isReceiverRegistered = true
      Log.d(TAG, "Screen & time tick receiver registered")
    } catch (e: Exception) {
      Log.w(TAG, "Failed to register screen/tick receiver", e)
    }
  }

  @Synchronized
  private fun unregisterReceiverIfNeeded() {
    if (!isReceiverRegistered) return
    try {
      context.unregisterReceiver(screenAndTickReceiver)
      isReceiverRegistered = false
      Log.d(TAG, "Screen & time tick receiver unregistered")
    } catch (e: Exception) {
      Log.w(TAG, "Failed to unregister screen/tick receiver", e)
    }
  }

  private fun stopLiveUpdateInternal(id: Int): Boolean {
    stopTicker()
    currentSession = null
    return try {
      notificationManager.cancel(id)
      true
    } catch (e: Exception) {
      Log.w(TAG, "Failed to cancel LiveUpdate notification id=$id", e)
      false
    }
  }

  private fun isLiveUpdateSupported(): Boolean {
    val isApi36OrAbove = Build.VERSION.SDK_INT >= 36 || Build.VERSION.CODENAME == "Baklava"
    return isApi36OrAbove
  }

  private fun canPostPromotedNotifications(): Boolean {
    if (!isLiveUpdateSupported()) return false
    return try {
      val method = notificationManager.javaClass.getMethod("canPostPromotedNotifications")
      (method.invoke(notificationManager) as? Boolean) ?: true
    } catch (_: Exception) {
      true
    }
  }

  private fun ensureNotificationChannel(channelId: String, channelName: String) {
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
          NotificationManager.IMPORTANCE_DEFAULT // 승격 조건: IMPORTANCE_MIN 불가
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

      // segments 설정
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

      // progress 설정
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

  private fun drawableToBitmap(drawable: Drawable): Bitmap? {
    if (drawable is BitmapDrawable && drawable.bitmap != null) {
      return drawable.bitmap
    }
    val width = if (drawable.intrinsicWidth > 0) drawable.intrinsicWidth else 192
    val height = if (drawable.intrinsicHeight > 0) drawable.intrinsicHeight else 192
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    drawable.setBounds(0, 0, canvas.width, canvas.height)
    drawable.draw(canvas)
    return bitmap
  }
}
