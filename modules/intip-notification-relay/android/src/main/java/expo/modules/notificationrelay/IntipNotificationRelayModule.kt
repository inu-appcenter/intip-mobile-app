package expo.modules.notificationrelay

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class IntipNotificationRelayModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext
      ?: throw IllegalStateException("React context is unavailable")

  private val listenerComponent: ComponentName
    get() = ComponentName(context, RelayListenerService::class.java)

  override fun definition() = ModuleDefinition {
    Name("IntipNotificationRelay")

    Function("setConfig") { json: String ->
      val config = try {
        RelayConfig.parse(JSONObject(json))
      } catch (e: Exception) {
        Log.w(TAG, "invalid relay config: ${e.message}")
        return@Function false
      }
      if (!RelayConfig.writeRaw(context, json)) return@Function false
      RelayNotifier.syncChannels(context, config)
      true
    }

    Function("getConfig") {
      RelayConfig.readRaw(context)
    }

    Function("getRecent") {
      RelayNotifier.readRecent(context)
    }

    Function("clearRecent") {
      RelayNotifier.clearRecent(context)
    }

    Function("isListenerPermissionGranted") {
      // NotificationManagerCompat.getEnabledListenerPackages와 같은 출처(androidx 의존 없이).
      val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners").orEmpty()
      flat.split(':').mapNotNull { ComponentName.unflattenFromString(it) }
        .any { it.packageName == context.packageName }
    }

    Function("openListenerSettings") {
      // Android 11+는 INTIP 상세 토글로 바로 간다. 사이드로드(내부 배포 APK)한 앱은 Android 13+에서
      // "제한된 설정"으로 막혀 있으니, 앱 정보 > ⋮ > 제한된 설정 허용을 먼저 안내해야 한다.
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
          .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, listenerComponent.flattenToString())
      } else {
        Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
      }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        context.startActivity(intent)
        true
      } catch (e: Exception) {
        try {
          context.startActivity(
            Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
          )
          true
        } catch (e2: Exception) {
          false
        }
      }
    }

    Function("requestRebind") {
      try {
        NotificationListenerService.requestRebind(listenerComponent)
        true
      } catch (e: Exception) {
        false
      }
    }

    Function("getActiveNotificationSources") {
      val service = RelayListenerService.instance?.get() ?: return@Function emptyList<Map<String, Any?>>()
      val active = try {
        service.activeNotifications ?: emptyArray()
      } catch (e: SecurityException) {
        emptyArray()
      }
      active.filter { it.packageName != context.packageName }
        .groupingBy { it.packageName }
        .eachCount()
        .map { (pkg, count) ->
          mapOf<String, Any?>("packageName" to pkg, "label" to labelOf(pkg), "activeCount" to count)
        }
    }
  }

  private fun labelOf(packageName: String): String? = try {
    val pm = context.packageManager
    pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
  } catch (e: PackageManager.NameNotFoundException) {
    null // Android 11+ 패키지 가시성 — <queries> 없이는 대부분 못 읽는다
  }

  companion object {
    private const val TAG = "NotificationRelay"
  }
}
