package expo.modules.intipnativedialog

import android.app.AlertDialog
import android.content.DialogInterface
import android.content.res.Configuration
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Resolved when the dialog goes away without a button press (back button, tap
 * outside). Mirrors what `Alert.alert`'s `onDismiss` would report.
 */
private const val DISMISSED = -1

data class AlertButton(@Field val text: String = "") : Record

data class AlertOptions(
  @Field val title: String? = null,
  @Field val message: String? = null,
  @Field val buttons: List<AlertButton> = emptyList(),
  @Field val cancelable: Boolean = true
) : Record

/**
 * A dialog styled by the *device* rather than by AndroidX.
 *
 * React Native's own `Alert` renders `androidx.appcompat.app.AlertDialog`
 * whenever the activity theme is AppCompat (ours is), and AppCompat draws the
 * dialog itself — so an OEM skin never gets a say and every device shows the
 * same Material dialog. Building the framework `android.app.AlertDialog`
 * against `Theme.DeviceDefault` instead hands styling back to the platform:
 * One UI on Samsung, Material You on Pixel, and so on.
 */
class IntipNativeDialogModule : Module() {
  private var visibleDialog: AlertDialog? = null

  override fun definition() = ModuleDefinition {
    Name("IntipNativeDialog")

    AsyncFunction("showAlert") { options: AlertOptions, promise: Promise ->
      val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()

      val isNight = (activity.resources.configuration.uiMode and
        Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
      val theme = if (isNight) {
        android.R.style.Theme_DeviceDefault_Dialog_Alert
      } else {
        android.R.style.Theme_DeviceDefault_Light_Dialog_Alert
      }

      // The promise must settle exactly once: a button press fires the click
      // listener *and* then the dismiss listener.
      val settled = AtomicBoolean(false)
      val settle = { index: Int ->
        if (settled.compareAndSet(false, true)) promise.resolve(index)
      }

      val builder = AlertDialog.Builder(activity, theme)
        .setCancelable(options.cancelable)
        .setOnDismissListener { dialog: DialogInterface ->
          settle(DISMISSED)
          if (visibleDialog === dialog) visibleDialog = null
        }

      options.title?.takeIf { it.isNotEmpty() }?.let { builder.setTitle(it) }
      options.message?.takeIf { it.isNotEmpty() }?.let { builder.setMessage(it) }

      // The framework dialog has three fixed slots, so we assign them from the
      // end of the list exactly like RN's Alert does: the last button is the
      // positive one, then negative, then neutral. Callers keep writing buttons
      // in reading order and get the placement Android users expect.
      val buttons = options.buttons.map { it.text }
      if (buttons.isEmpty()) {
        builder.setPositiveButton(android.R.string.ok) { _, _ -> settle(0) }
      } else {
        val last = buttons.size - 1
        builder.setPositiveButton(buttons[last]) { _, _ -> settle(last) }
        if (buttons.size >= 2) {
          builder.setNegativeButton(buttons[last - 1]) { _, _ -> settle(last - 1) }
        }
        if (buttons.size >= 3) {
          builder.setNeutralButton(buttons[last - 2]) { _, _ -> settle(last - 2) }
        }
      }

      // Only one at a time — a stacked dialog would leak its window if the
      // activity went away underneath it.
      visibleDialog?.dismiss()
      visibleDialog = builder.show()
    }.runOnQueue(Queues.MAIN)

    OnDestroy {
      visibleDialog?.dismiss()
      visibleDialog = null
    }
  }
}
