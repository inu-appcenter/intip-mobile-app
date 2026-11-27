// Installed into the main app target by plugins/withNotificationRelayIntent.js.
// Edit this file, not the copy under ios/ (prebuild overwrites it).
//
// iOS 27 단축어 자동화 "알림을 받았을 때(앱: 스마트캠퍼스)" → 이 인텐트에 알림 제목/내용을 넘긴다
// → 키워드로 분류해 INTIP 로컬 알림으로 다시 띄운다.
//
// 원본 알림은 앱이 지울 수 없다. 그래서 사용자가 스마트캠퍼스 알림을 조용하게 만들어 둬야 한다:
//   (권장) 설정 > 알림 > 스마트캠퍼스 > 배너·소리 끄기(알림 센터만 켜 둠)
//   (대안) 집중 모드에 스마트캠퍼스를 무음 앱으로 넣고 INTIP은 허용
// 알림을 아예 끄면 자동화도 안 돌 가능성이 높다 — 실기기 확인 필요(docs/notification-relay/plan.md).
//
// 메인 앱 타깃에 두는 이유: App Intents 메타데이터 추출은 인텐트 소스를 가진 타깃에서만 돈다.
// static framework(useFrameworks: static)로 링크되는 Expo 모듈 pod에 두면 단축어에 안 보인다.
// openAppWhenRun = false라 앱 UI 없이 백그라운드로 실행되고, JS 런타임은 쓰지 않는다.

import AppIntents
import Foundation
import UserNotifications

// MARK: - 저장소 (키는 modules/intip-notification-relay/ios/IntipNotificationRelayModule.swift와 같아야 함)

enum NotificationRelayStore {
  static let configKey = "intip.notificationRelay.config"
  static let recentKey = "intip.notificationRelay.recent"
  static let maxRecent = 30

  static func loadConfig() -> NotificationRelayConfig? {
    guard let raw = UserDefaults.standard.string(forKey: configKey),
          let data = raw.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(NotificationRelayConfig.self, from: data)
  }

  static func appendRecent(title: String, body: String, categoryId: String, dropped: Bool) {
    let defaults = UserDefaults.standard
    var entries: [[String: Any]] = []
    if let raw = defaults.string(forKey: recentKey),
       let data = raw.data(using: .utf8),
       let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
      entries = parsed
    }
    entries.insert([
      "at": Int(Date().timeIntervalSince1970 * 1000),
      "source": "shortcut",
      "title": title,
      "body": body,
      "categoryId": categoryId,
      "dropped": dropped,
    ], at: 0)
    entries = Array(entries.prefix(maxRecent))
    if let data = try? JSONSerialization.data(withJSONObject: entries),
       let raw = String(data: data, encoding: .utf8) {
      defaults.set(raw, forKey: recentKey)
    }
  }
}

// MARK: - 설정 (src/config.ts의 NotificationRelayConfig 중 iOS가 쓰는 부분)

struct NotificationRelayCategory: Decodable {
  let id: String
  let name: String
  let keywords: [String]?
  let importance: String?
  let drop: Bool?
}

struct NotificationRelayConfig: Decodable {
  let enabled: Bool?
  let categories: [NotificationRelayCategory]?
  let fallback: NotificationRelayCategory?
}

// MARK: - 분류기 (src/config.ts의 classifyNotification과 같은 규칙)

enum NotificationRelayClassifier {
  static let defaultFallback = NotificationRelayCategory(
    id: "etc", name: "기타", keywords: [], importance: "low", drop: false
  )

  static func normalize(_ text: String) -> String {
    text.components(separatedBy: .whitespacesAndNewlines).joined().lowercased()
  }

  static func classify(
    _ config: NotificationRelayConfig, title: String, body: String
  ) -> (category: NotificationRelayCategory, keyword: String?) {
    let haystack = normalize("\(title)\n\(body)")
    for category in config.categories ?? [] {
      for keyword in category.keywords ?? [] {
        let needle = normalize(keyword)
        if !needle.isEmpty && haystack.contains(needle) {
          return (category, keyword)
        }
      }
    }
    return (config.fallback ?? defaultFallback, nil)
  }
}

// MARK: - 인텐트

@available(iOS 16.0, *)
struct RelayNotificationIntent: AppIntent {
  static let title: LocalizedStringResource = "알림 분류해서 다시 보내기"
  static let description = IntentDescription(
    "받은 알림의 제목과 내용을 INTIP에 등록한 키워드로 분류해, 카테고리별 INTIP 알림으로 다시 보냅니다. 단축어의 '알림을 받았을 때' 자동화에서 사용하세요."
  )
  static let openAppWhenRun: Bool = false

  @Parameter(title: "제목", default: "")
  var notificationTitle: String

  @Parameter(title: "내용", default: "")
  var notificationBody: String

  static var parameterSummary: some ParameterSummary {
    Summary("\(\.$notificationTitle), \(\.$notificationBody) 분류해서 다시 보내기")
  }

  /// 분류된 카테고리 이름을 돌려준다(단축어에서 이어서 쓸 수 있게). 꺼져 있으면 빈 문자열.
  func perform() async throws -> some IntentResult & ReturnsValue<String> {
    guard let config = NotificationRelayStore.loadConfig(), config.enabled == true else {
      return .result(value: "")
    }
    let title = notificationTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    let body = notificationBody.trimmingCharacters(in: .whitespacesAndNewlines)
    if title.isEmpty && body.isEmpty { return .result(value: "") }

    let (category, _) = NotificationRelayClassifier.classify(config, title: title, body: body)
    let dropped = category.drop == true
    if !dropped {
      try await post(category: category, title: title, body: body)
    }
    NotificationRelayStore.appendRecent(
      title: title, body: body, categoryId: category.id, dropped: dropped
    )
    return .result(value: category.name)
  }

  private func post(category: NotificationRelayCategory, title: String, body: String) async throws {
    let content = UNMutableNotificationContent()
    content.title = "[\(category.name)] \(title.isEmpty ? "스마트캠퍼스" : title)"
    content.body = body
    // 같은 카테고리끼리 알림 센터에서 묶인다.
    content.threadIdentifier = "intip_relay_\(category.id)"
    content.userInfo = ["intipRelay": true, "categoryId": category.id]
    switch category.importance {
    case "low":
      content.sound = nil
      content.interruptionLevel = .passive
    case "high":
      content.sound = .default
      content.interruptionLevel = .active // timeSensitive는 엔타이틀먼트가 필요해서 보류
    default:
      content.sound = .default
      content.interruptionLevel = .active
    }
    // TODO: 탭하면 스마트캠퍼스의 해당 화면을 열고 싶지만 원본의 딥링크를 알 수 없다(단축어가
    // 알림 내용만 넘겨준다). 지금은 탭하면 INTIP이 열린다.
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    try await UNUserNotificationCenter.current().add(request)
  }
}
