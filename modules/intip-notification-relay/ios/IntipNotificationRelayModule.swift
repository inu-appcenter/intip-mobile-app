import ExpoModulesCore

/// iOS에서는 다른 앱의 알림을 앱이 직접 읽을 수 없다. 대신 iOS 27 단축어의 "알림을 받았을 때"
/// 자동화가 `RelayNotificationIntent`(plugins/notification-relay-ios/, 메인 앱 타깃)를 부르고,
/// 그 인텐트가 여기서 저장한 설정으로 분류한다.
///
/// 이 모듈은 설정/내역을 UserDefaults에 읽고 쓰기만 한다. 인텐트는 앱 프로세스에서 돌기 때문에
/// App Group 없이 `UserDefaults.standard`를 같이 쓴다. 키는 인텐트 쪽 `NotificationRelayStore`와
/// 반드시 같아야 한다.
public class IntipNotificationRelayModule: Module {
  private static let configKey = "intip.notificationRelay.config"
  private static let recentKey = "intip.notificationRelay.recent"

  public func definition() -> ModuleDefinition {
    Name("IntipNotificationRelay")

    Function("setConfig") { (json: String) -> Bool in
      guard let data = json.data(using: .utf8),
            (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else {
        return false
      }
      UserDefaults.standard.set(json, forKey: Self.configKey)
      return true
    }

    Function("getConfig") { () -> String? in
      UserDefaults.standard.string(forKey: Self.configKey)
    }

    Function("getRecent") { () -> String in
      UserDefaults.standard.string(forKey: Self.recentKey) ?? "[]"
    }

    Function("clearRecent") {
      UserDefaults.standard.removeObject(forKey: Self.recentKey)
    }

    // Android 전용 API. JS 쪽 시그니처를 맞추려고 둔다.
    Function("isListenerPermissionGranted") { false }
    Function("openListenerSettings") { false }
    Function("requestRebind") { false }
    Function("getActiveNotificationSources") { () -> [[String: Any]] in [] }
  }
}
