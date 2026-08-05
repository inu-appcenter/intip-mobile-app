/**
 * Drop-in replacement for `Alert.alert` that renders the *device's* dialog.
 *
 * On Android, RN's `Alert` draws an AndroidX (Material) dialog because our
 * activity theme is AppCompat, so a Galaxy shows the same dialog as a Pixel.
 * This routes through a small native module built against `Theme.DeviceDefault`
 * instead, which is what gives One UI on Samsung and Material You on Pixel.
 *
 * iOS already gets `UIAlertController` from RN's `Alert`, so it just delegates.
 */
import { Alert, Platform, type AlertButton } from 'react-native';

import IntipNativeDialogModule from './src/IntipNativeDialogModule';

export type NativeAlertOptions = {
  cancelable?: boolean;
  onDismiss?: () => void;
};

/**
 * Same signature as `Alert.alert`, minus the iOS-only prompt variants.
 *
 * `style` on a button ('cancel' / 'destructive') is honoured on iOS only — the
 * framework dialog on Android has three fixed slots and no destructive styling.
 * Button placement follows RN's convention: the last button is the positive
 * one, then negative, then neutral, so keep writing them in reading order.
 */
export function nativeAlert(
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: NativeAlertOptions,
): void {
  if (Platform.OS !== 'android' || !IntipNativeDialogModule) {
    Alert.alert(title, message, buttons, options);
    return;
  }

  const list = buttons ?? [];
  IntipNativeDialogModule.showAlert({
    title,
    message,
    // An empty list makes the native side fall back to the OS-localised "OK".
    buttons: list.map((button) => ({ text: button.text ?? '' })),
    cancelable: options?.cancelable ?? true,
  })
    .then((index) => {
      if (index < 0) {
        options?.onDismiss?.();
        return;
      }
      list[index]?.onPress?.();
    })
    .catch(() => {
      // No activity, or the native module misbehaved: better a Material dialog
      // than none at all.
      Alert.alert(title, message, buttons, options);
    });
}
