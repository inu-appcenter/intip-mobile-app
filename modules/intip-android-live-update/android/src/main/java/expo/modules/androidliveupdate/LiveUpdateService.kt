package expo.modules.androidliveupdate

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Foreground Service for Android 16 / One UI 8 Live Update (Now Bar).
 * Prevents OS from killing the app process (adj 200 vs adj 850)
 * ensuring uninterrupted real-time updates even when the user switches to other apps.
 */
class LiveUpdateService : Service() {

  companion object {
    const val ACTION_START = "expo.modules.androidliveupdate.ACTION_START"
    const val ACTION_STOP = "expo.modules.androidliveupdate.ACTION_STOP"
    @Volatile
    var isRunning = false
      private set
  }

  private var isReceiverRegistered = false

  private val tickReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      when (intent?.action) {
        Intent.ACTION_TIME_TICK,
        Intent.ACTION_SCREEN_ON,
        Intent.ACTION_USER_PRESENT -> {
          Log.d(TAG, "[LiveUpdateService] Broadcast received (${intent.action}), refreshing LiveUpdate")
          context?.let { LiveUpdateManager.onTick(it) }
        }
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    registerTickReceiver()
    isRunning = true
    Log.i(TAG, "[LiveUpdateService] Service created")
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action ?: ACTION_START
    Log.d(TAG, "[LiveUpdateService] onStartCommand action=$action")

    if (action == ACTION_STOP) {
      stopForegroundInternal()
      stopSelf()
      return START_NOT_STICKY
    }

    val session = LiveUpdateManager.loadSession(this)
    if (session == null || !session.ongoing) {
      Log.w(TAG, "[LiveUpdateService] No active ongoing session found, stopping service")
      stopForegroundInternal()
      stopSelf()
      return START_NOT_STICKY
    }

    try {
      val notification = LiveUpdateManager.createNotificationFromSession(this, session)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val fgsType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        }
        startForeground(session.id, notification, fgsType)
      } else {
        startForeground(session.id, notification)
      }
      Log.i(TAG, "[LiveUpdateService] Successfully started foreground with id=${session.id}")
    } catch (e: Exception) {
      Log.e(TAG, "[LiveUpdateService] Failed to start foreground service", e)
    }

    return START_STICKY
  }

  private fun stopForegroundInternal() {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        stopForeground(STOP_FOREGROUND_REMOVE)
      } else {
        @Suppress("DEPRECATION")
        stopForeground(true)
      }
    } catch (e: Exception) {
      Log.w(TAG, "[LiveUpdateService] Error in stopForeground", e)
    }
  }

  private fun registerTickReceiver() {
    if (isReceiverRegistered) return
    try {
      val filter = IntentFilter().apply {
        addAction(Intent.ACTION_TIME_TICK)
        addAction(Intent.ACTION_SCREEN_ON)
        addAction(Intent.ACTION_USER_PRESENT)
      }
      registerReceiver(tickReceiver, filter)
      isReceiverRegistered = true
      Log.d(TAG, "[LiveUpdateService] Tick receiver registered")
    } catch (e: Exception) {
      Log.w(TAG, "[LiveUpdateService] Failed to register tick receiver", e)
    }
  }

  private fun unregisterTickReceiver() {
    if (!isReceiverRegistered) return
    try {
      unregisterReceiver(tickReceiver)
      isReceiverRegistered = false
      Log.d(TAG, "[LiveUpdateService] Tick receiver unregistered")
    } catch (e: Exception) {
      Log.w(TAG, "[LiveUpdateService] Failed to unregister tick receiver", e)
    }
  }

  override fun onDestroy() {
    unregisterTickReceiver()
    isRunning = false
    Log.i(TAG, "[LiveUpdateService] Service destroyed")
    super.onDestroy()
  }
}
