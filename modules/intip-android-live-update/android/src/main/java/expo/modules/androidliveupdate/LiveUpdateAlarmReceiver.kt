package expo.modules.androidliveupdate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Log

class LiveUpdateAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    Log.d("IntipLiveUpdate", "LiveUpdateAlarmReceiver onReceive triggered: action=${intent?.action}")
    val pendingResult = goAsync()

    val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
    val wakeLock = powerManager?.newWakeLock(
      PowerManager.PARTIAL_WAKE_LOCK,
      "intip:LiveUpdateAlarmWakeLock"
    )?.apply {
      // 최대 3초 동안만 CPU를 유지하도록 타임아웃 보호
      acquire(3000L)
    }

    try {
      LiveUpdateManager.onTick(context)
    } catch (e: Exception) {
      Log.e("IntipLiveUpdate", "Error during LiveUpdateAlarmReceiver onTick", e)
    } finally {
      try {
        if (wakeLock != null && wakeLock.isHeld) {
          wakeLock.release()
        }
      } catch (_: Exception) {}
      pendingResult.finish()
    }
  }
}
