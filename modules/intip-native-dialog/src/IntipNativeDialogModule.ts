import { NativeModule, requireOptionalNativeModule } from 'expo';

export type NativeAlertOptions = {
  title?: string;
  message?: string;
  buttons?: { text: string }[];
  cancelable?: boolean;
};

declare class IntipNativeDialogModule extends NativeModule {
  /**
   * Resolves with the index of the pressed button in `buttons`, or -1 when the
   * dialog was dismissed without a press (back button / tap outside).
   */
  showAlert(options: NativeAlertOptions): Promise<number>;
}

/**
 * Optional on purpose: the module only exists on Android, and a JS bundle can
 * outrun the native binary via EAS Update. Callers fall back to RN's `Alert`.
 */
export default requireOptionalNativeModule<IntipNativeDialogModule>('IntipNativeDialog');
