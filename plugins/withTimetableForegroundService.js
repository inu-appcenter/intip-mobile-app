const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

const PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
];

module.exports = function withTimetableForegroundService(config) {
  return withAndroidManifest(config, (cfg) => {
    // 1. 필요한 uses-permission 추가
    for (const permission of PERMISSIONS) {
      AndroidConfig.Permissions.addPermission(cfg.modResults, permission);
    }

    // 2. Notifee ForegroundService 서비스 등록 (Android 14+ specialUse / dataSync 타입 필수)
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    mainApplication.service = mainApplication.service || [];

    const existingServiceIndex = mainApplication.service.findIndex(
      (s) => s.$['android:name'] === 'app.notifee.core.ForegroundService',
    );

    const serviceDefinition = {
      $: {
        'android:name': 'app.notifee.core.ForegroundService',
        'android:foregroundServiceType': 'specialUse|dataSync',
        'android:exported': 'false',
      },
      property: [
        {
          $: {
            'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
            'android:value': 'Timetable live ongoing activity',
          },
        },
      ],
    };

    if (existingServiceIndex >= 0) {
      mainApplication.service[existingServiceIndex] = serviceDefinition;
    } else {
      mainApplication.service.push(serviceDefinition);
    }

    return cfg;
  });
};
