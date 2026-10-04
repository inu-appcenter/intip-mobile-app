package expo.modules.androidliveupdate

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.graphics.Color
import android.os.Build
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val TAG = "IntipLiveUpdate"

class IntipAndroidLiveUpdateModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context is unavailable")

  private val notificationManager: NotificationManager
    get() = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  override fun definition() = ModuleDefinition {
    Name("IntipAndroidLiveUpdate")

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
        val channelId = options["channelId"] as? String ?: "timetable_nowbar_v2"
        val channelName = options["channelName"] as? String ?: "실시간 시간표 (나우 바)"
        val title = options["title"] as? String ?: ""
        val text = options["text"] as? String ?: ""
        val shortCriticalText = (options["shortCriticalText"] as? String)?.take(7)
        val progress = (options["progress"] as? Number)?.toInt()
        val segmentsRaw = options["segments"] as? List<Map<String, Any?>>
        val targetTimestamp = (options["targetTimestamp"] as? Number)?.toLong()
        val ongoing = options["ongoing"] as? Boolean ?: true

        // 1. 알림 채널 보장 (IMPORTANCE_DEFAULT 이상 필수)
        ensureNotificationChannel(channelId, channelName)

        // 2. Notification.Builder 초기화
        val builder = Notification.Builder(context, channelId)
          .setContentTitle(title)
          .setContentText(text)
          .setSmallIcon(context.applicationInfo.icon)
          .setOngoing(ongoing)
          .setOnlyAlertOnce(true)
          .setAutoCancel(false)

        // 클릭 시 앱 실행 펜딩 인텐트 연결
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

        // 3. Status Bar Chip 및 Now Bar 캡슐용 7자 이내 핵심 상태 텍스트
        if (!shortCriticalText.isNullOrEmpty()) {
          applyShortCriticalText(builder, shortCriticalText)
        }

        // 4. Android 16 setRequestPromotedOngoing(true) 적용
        applyRequestPromotedOngoing(builder, true)

        // 5. 카운트다운 타이머 연동
        if (targetTimestamp != null && targetTimestamp > 0) {
          builder.setWhen(targetTimestamp)
          builder.setUsesChronometer(true)
          try {
            // Android 7.0+ setChronometerCountDown
            Notification.Builder::class.java
              .getMethod("setChronometerCountDown", Boolean::class.javaPrimitiveType)
              .invoke(builder, true)
          } catch (_: Exception) {}
        }

        // 6. Notification.ProgressStyle 적용
        val styled = applyProgressStyle(builder, progress, segmentsRaw)
        if (!styled && progress != null) {
          // ProgressStyle 실패 시 기본 프로그레스바 설정
          builder.setProgress(100, progress.coerceIn(0, 100), false)
        }

        // 7. 알림 빌드 및 승격 조건 검증
        val notification = builder.build()
        val promotable = checkPromotableCharacteristics(notification)

        Log.i(TAG, "Posting LiveUpdate notification id=$id, promotable=$promotable, shortText=$shortCriticalText")
        notificationManager.notify(id, notification)

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
      try {
        notificationManager.cancel(id)
        true
      } catch (e: Exception) {
        Log.w(TAG, "Failed to cancel LiveUpdate notification id=$id", e)
        false
      }
    }
  }

  private fun isLiveUpdateSupported(): Boolean {
    // Android 16 (API 36) 또는 개발자 프리뷰(Baklava)
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
      val existing = notificationManager.getNotificationChannel(channelId)
      if (existing == null) {
        val channel = NotificationChannel(
          channelId,
          channelName,
          NotificationManager.IMPORTANCE_DEFAULT // 승격 조건: IMPORTANCE_MIN 불가
        ).apply {
          description = "Now Bar 실시간 라이브 업데이트 알림"
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
          setSound(null, null)
          enableVibration(false)
          setShowBadge(false)
        }
        notificationManager.createNotificationChannel(channel)
      }
    }
  }

  private fun applyShortCriticalText(builder: Notification.Builder, text: String) {
    try {
      val method = Notification.Builder::class.java.getMethod("setShortCriticalText", CharSequence::class.java)
      method.invoke(builder, text)
    } catch (e: Exception) {
      Log.d(TAG, "setShortCriticalText not available on this API level")
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
}
