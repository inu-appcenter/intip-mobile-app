package expo.modules.androidliveupdate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class LiveUpdateAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    Log.d("IntipLiveUpdate", "LiveUpdateAlarmReceiver onReceive triggered: action=${intent?.action}")
    LiveUpdateManager.onTick(context)
  }
}
