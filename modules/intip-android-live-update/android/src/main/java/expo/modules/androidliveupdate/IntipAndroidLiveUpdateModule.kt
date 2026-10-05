package expo.modules.androidliveupdate

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.provider.Settings
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class IntipAndroidLiveUpdateModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: appContext.reactContext ?: throw IllegalStateException("React context is unavailable")

  private val notificationManager: NotificationManager
    get() = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private var isReceiverRegistered = false

  private val screenReceiver = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context?, intent: Intent?) {
      when (intent?.action) {
        Intent.ACTION_SCREEN_ON,
        Intent.ACTION_USER_PRESENT -> {
          Log.d(TAG, "Screen on / user present received, refreshing LiveUpdate")
          ctx?.let { LiveUpdateManager.onTick(it) }
        }
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("IntipAndroidLiveUpdate")

    OnDestroy {
      unregisterScreenReceiverIfNeeded()
    }

    Function("isSupported") {
      LiveUpdateManager.isLiveUpdateSupported()
    }

    Function("canPostPromoted") {
      LiveUpdateManager.canPostPromotedNotifications(notificationManager)
    }

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
        val timeRange = options["timeRange"] as? String
        val locationAndProf = options["locationAndProf"] as? String
        val details = options["details"] as? String
        val showChronometer = options["showChronometer"] as? Boolean ?: false
        val showWhen = options["showWhen"] as? Boolean ?: false
        val ongoing = options["ongoing"] as? Boolean ?: true

        val session = LiveUpdateSession(
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

        val promotable = LiveUpdateManager.buildAndPostNotification(
          context = context,
          id = id,
          channelId = channelId,
          channelName = channelName,
          title = title,
          text = text,
          shortCriticalText = shortCriticalText,
          progress = progress,
          segmentsRaw = segmentsRaw,
          targetTimestamp = targetTimestamp,
          showChronometer = showChronometer,
          showWhen = showWhen,
          ongoing = ongoing
        )

        if (ongoing) {
          LiveUpdateManager.saveSession(context, session)
          LiveUpdateManager.scheduleNextAlarm(context, session)
          registerScreenReceiverIfNeeded()
        } else {
          LiveUpdateManager.stopLiveUpdate(context, id)
          unregisterScreenReceiverIfNeeded()
        }

        mapOf(
          "success" to true,
          "promotable" to promotable,
          "isSupported" to LiveUpdateManager.isLiveUpdateSupported()
        )
      } catch (e: Exception) {
        Log.e(TAG, "Failed to post LiveUpdate notification", e)
        mapOf(
          "success" to false,
          "error" to (e.message ?: "Unknown error")
        )
      }
    }

    Function("stopLiveUpdate") { id: Int ->
      unregisterScreenReceiverIfNeeded()
      LiveUpdateManager.stopLiveUpdate(context, id)
    }

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

  @Synchronized
  private fun registerScreenReceiverIfNeeded() {
    if (isReceiverRegistered) return
    try {
      val filter = IntentFilter().apply {
        addAction(Intent.ACTION_SCREEN_ON)
        addAction(Intent.ACTION_USER_PRESENT)
      }
      context.registerReceiver(screenReceiver, filter)
      isReceiverRegistered = true
      Log.d(TAG, "Screen receiver registered on applicationContext")
    } catch (e: Exception) {
      Log.w(TAG, "Failed to register screen receiver", e)
    }
  }

  @Synchronized
  private fun unregisterScreenReceiverIfNeeded() {
    if (!isReceiverRegistered) return
    try {
      context.unregisterReceiver(screenReceiver)
      isReceiverRegistered = false
      Log.d(TAG, "Screen receiver unregistered")
    } catch (e: Exception) {
      Log.w(TAG, "Failed to unregister screen receiver", e)
    }
  }
}
