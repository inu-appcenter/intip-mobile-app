/**
 * File downloads.
 * Swift ref: `WKDownloadDelegate` -> "다운로드 완료" / "파일이 저장되었습니다.".
 *
 * iOS:     fired from `<WebView onFileDownload>`; we pull the file with
 *          react-native-blob-util into the app's document directory.
 * Android: `onFileDownload` is not emitted, so the WebView detects a
 *          downloadable navigation (Content-Disposition / known extension) and
 *          calls `saveDownload`, which hands off to the system DownloadManager
 *          (scoped storage, with a progress notification).
 */
import { Alert, Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { STRINGS } from '../webview/constants';
import { fileNameFromUrl } from './fileName';

function notifyComplete(): void {
  Alert.alert(STRINGS.download.title, STRINGS.download.message);
}

/**
 * Download `url` to the device. Routes to the Android DownloadManager (scoped
 * storage + notification) or to the iOS document directory.
 */
export async function saveDownload(url: string, suggestedName?: string): Promise<void> {
  const filename = suggestedName || fileNameFromUrl(url);

  try {
    if (Platform.OS === 'android') {
      const { dirs } = ReactNativeBlobUtil.fs;
      await ReactNativeBlobUtil.config({
        addAndroidDownloads: {
          useDownloadManager: true,
          notification: true,
          mediaScannable: true,
          title: filename,
          path: `${dirs.DownloadDir}/${filename}`,
        },
      }).fetch('GET', url);
    } else {
      const { dirs } = ReactNativeBlobUtil.fs;
      await ReactNativeBlobUtil.config({
        path: `${dirs.DocumentDir}/${filename}`,
      }).fetch('GET', url);
    }
    notifyComplete();
  } catch (err) {
    console.warn('[downloads] failed', err);
  }
}
