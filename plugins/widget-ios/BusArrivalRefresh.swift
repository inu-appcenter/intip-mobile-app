// Copied into the ExpoWidgetsTarget by plugins/withBusArrivalRefreshIntent.js.
// /ios is prebuild output; edit this file, not the copy under ios/.
//
// In-place refresh for the 인입런 (BusArrivalWidget) home screen widget.
//
// A WidgetKit button runs its intent in the widget extension, in the
// background, without opening the app — and the reload that follows a tap
// doesn't count against WidgetKit's daily reload budget. That makes a tap the
// one way an iOS widget can show a fresh bus estimate on demand.
//
// expo-widgets' own `Button` can't be used for this: it always maps to its
// `WidgetUserInteraction` intent, which only re-evaluates the layout's press
// handler (a pure JSContext with no network) and pings the app if it happens
// to be running. So this file supplies its own intent, and the plugin wraps
// the generated `BusArrivalWidget` entry view with a tap target over the
// refresh icon the layout already draws in its bottom-trailing corner.
//
// The fetch and the snapshot it writes are a Swift port of the app's
// `refreshBusArrivalWidget` (src/widgets/refresh.ts) and the pure functions it
// uses in src/widgets/data/busArrival.ts — `withObservedAt`,
// `arrivalsForStop`, `arrivalBoundariesOf`, `toBusArrivalProps`. Keep the two
// in step. What it deliberately does not port is choosing the stop: that
// needs the user's location, which the extension doesn't have, so it reuses
// whatever stop the app last picked (the `source` the app writes into every
// entry's props). Without one — the app has never refreshed this widget —
// a tap does nothing.

import AppIntents
import SwiftUI
import WidgetKit
internal import ExpoWidgets

private let widgetName = "BusArrivalWidget"

/** The generated widget's entry view, with the refresh tap target added. */
struct BusArrivalEntryView: View {
  let entry: WidgetsTimelineEntry

  var body: some View {
    if #available(iOS 17.0, *) {
      WidgetsEntryView(entry: entry)
        // Dims the content while a tap's refresh is running — the only
        // progress feedback a widget can give.
        .invalidatableContent()
        .overlay(alignment: .bottomTrailing) {
          // 44pt is the minimum tap target; the layout's icon is 12pt, inset
          // 16pt from both edges, so this square covers it with room to spare.
          // A Button in a widget takes its area away from `widgetURL`, so the
          // rest of the widget still opens the app.
          Button(intent: RefreshBusArrivalIntent()) {
            Color.clear
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("버스 도착 정보 새로고침")
        }
    } else {
      WidgetsEntryView(entry: entry)
    }
  }
}

@available(iOS 17.0, *)
struct RefreshBusArrivalIntent: AppIntent {
  static var title: LocalizedStringResource = "인입런 새로고침"
  static var isDiscoverable: Bool = false

  init() {}

  func perform() async throws -> some IntentResult {
    await BusArrivalRefresh.run(now: Date())
    // WidgetKit reloads the widget a button's intent belongs to on its own;
    // this is for the case it ever stops doing that.
    WidgetCenter.shared.reloadTimelines(ofKind: widgetName)
    return .result()
  }
}

enum BusArrivalRefresh {
  /** Mirrors `ARRIVING_SOON_SECONDS` in busArrival.ts. */
  static let arrivingSoonSeconds = 60

  /** Mirrors `REQUEST_TIMEOUT_MS` in apiClient.ts. */
  static let requestTimeout: TimeInterval = 10

  private static var timelineKey: String { "__expo_widgets_\(widgetName)_timeline" }

  private static var defaults: UserDefaults? {
    let group = Bundle.main.object(forInfoDictionaryKey: "ExpoWidgetsAppGroupIdentifier") as? String
    return group.flatMap { UserDefaults(suiteName: $0) }
  }

  /**
   * Refetches arrivals for the stop the app last chose and rewrites the
   * widget's timeline. Any failure leaves the timeline as it was — same rule
   * as the app: the last good snapshot beats an error the user can't act on.
   */
  static func run(now: Date) async {
    guard let defaults,
          let source = currentSource(defaults),
          let items = await fetchArrivals(source: source) else {
      return
    }

    let nowMs = Int64((now.timeIntervalSince1970 * 1000).rounded())
    let arrivals = withObservedAt(arrivalsForStop(items, routeIds: source.routeIds), fetchedAtMs: nowMs)
    let moments = [nowMs] + arrivalBoundaries(arrivals, nowMs: nowMs)
    let entries: [[String: Any]] = moments.map { at in
      ["timestamp": Int(at), "props": props(arrivals, source: source, atMs: at)]
    }
    defaults.set(entries, forKey: timelineKey)
  }

  // MARK: - Source (written by the app)

  struct Source {
    let apiBaseUrl: String
    let bstopId: String
    let stopLabel: String
    let routeIds: [String]

    /** Back to the dictionary shape the app writes, so a rewrite keeps it. */
    var dictionary: [String: Any] {
      ["apiBaseUrl": apiBaseUrl, "bstopId": bstopId, "stopLabel": stopLabel, "routeIds": routeIds]
    }
  }

  private static func currentSource(_ defaults: UserDefaults) -> Source? {
    let timeline = defaults.array(forKey: timelineKey) as? [[String: Any]] ?? []
    for entry in timeline {
      guard let props = entry["props"] as? [String: Any],
            let raw = props["source"] as? [String: Any],
            let apiBaseUrl = raw["apiBaseUrl"] as? String,
            let bstopId = raw["bstopId"] as? String,
            let stopLabel = raw["stopLabel"] as? String else {
        continue
      }
      return Source(
        apiBaseUrl: apiBaseUrl,
        bstopId: bstopId,
        stopLabel: stopLabel,
        routeIds: raw["routeIds"] as? [String] ?? []
      )
    }
    return nil
  }

  // MARK: - Fetch

  struct Item {
    let routeId: String?
    let routeNo: String?
    let etaSeconds: Double?
    var observedAtMs: Int64?
  }

  private static func fetchArrivals(source: Source) async -> [Item]? {
    guard var components = URLComponents(string: "\(source.apiBaseUrl)/api/buses/arrivals") else {
      return nil
    }
    components.queryItems = [URLQueryItem(name: "bstopId", value: source.bstopId)]
    guard let url = components.url else { return nil }

    var request = URLRequest(url: url, timeoutInterval: requestTimeout)
    request.setValue("application/json", forHTTPHeaderField: "Accept")

    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let rows = body["data"] as? [[String: Any]] else {
        return nil
      }
      return rows.map(item(from:))
    } catch {
      return nil
    }
  }

  /** `etaSecondsOf` in busArrival.ts: the backend's seconds, else the raw upstream field. */
  private static func item(from row: [String: Any]) -> Item {
    var eta: Double?
    if let seconds = (row["estimatedArrivalSeconds"] as? NSNumber)?.doubleValue, seconds >= 0 {
      eta = seconds
    } else if let raw = numberValue(row["arrivalEstimateTime"]), raw >= 0 {
      eta = raw
    }
    return Item(
      routeId: row["routeId"] as? String,
      routeNo: row["routeNo"] as? String,
      etaSeconds: eta,
      observedAtMs: (row["observedAt"] as? NSNumber)?.int64Value
    )
  }

  /** JS `Number(x)` for the two shapes the field comes in. */
  private static func numberValue(_ value: Any?) -> Double? {
    if let number = value as? NSNumber { return number.doubleValue }
    if let string = value as? String {
      let trimmed = string.trimmingCharacters(in: .whitespaces)
      if trimmed.isEmpty { return 0 }
      if let parsed = Double(trimmed), parsed.isFinite { return parsed }
    }
    return nil
  }

  // MARK: - Transform (port of busArrival.ts)

  private static func arrivalsForStop(_ items: [Item], routeIds: [String]) -> [Item] {
    if routeIds.isEmpty { return items }
    return items.filter { item in item.routeId.map(routeIds.contains) ?? false }
  }

  private static func withObservedAt(_ items: [Item], fetchedAtMs: Int64) -> [Item] {
    items.map { item in
      var pinned = item
      if pinned.observedAtMs == nil { pinned.observedAtMs = fetchedAtMs }
      return pinned
    }
  }

  private static func trimmedRoute(_ item: Item) -> String? {
    guard let route = item.routeNo?.trimmingCharacters(in: .whitespacesAndNewlines), !route.isEmpty else {
      return nil
    }
    return route
  }

  private static func arrivesAt(_ item: Item, nowMs: Int64) -> Int64? {
    guard let eta = item.etaSeconds, trimmedRoute(item) != nil else { return nil }
    return (item.observedAtMs ?? nowMs) + Int64((eta * 1000).rounded())
  }

  private static func arrivalBoundaries(_ items: [Item], nowMs: Int64) -> [Int64] {
    var instants = Set<Int64>()
    for item in items {
      guard let at = arrivesAt(item, nowMs: nowMs) else { continue }
      for moment in [at - Int64(arrivingSoonSeconds) * 1000, at] where moment > nowMs {
        instants.insert(moment)
      }
    }
    return instants.sorted()
  }

  private static func props(_ items: [Item], source: Source, atMs: Int64) -> [String: Any] {
    let rows: [(arrivesAt: Int64, row: [String: Any])] = items.compactMap { item in
      guard let route = trimmedRoute(item), let arrivesAt = arrivesAt(item, nowMs: atMs) else { return nil }
      let remaining = Int((Double(arrivesAt - atMs) / 1000).rounded())
      if remaining <= 0 { return nil }
      return (arrivesAt, [
        "route": route,
        "eta": formatEta(remaining),
        "soon": remaining <= arrivingSoonSeconds,
        "arrivesAt": arrivesAt,
        "observedLabel": formatObservedAt(item.observedAtMs ?? atMs),
      ])
    }
    let shown = rows.sorted { $0.arrivesAt < $1.arrivesAt }.prefix(3).map(\.row)

    if shown.isEmpty {
      return ["status": "noData", "source": source.dictionary]
    }
    return ["status": "normal", "stopLabel": source.stopLabel, "arrivals": shown, "source": source.dictionary]
  }

  private static func formatEta(_ seconds: Int) -> String {
    if seconds <= arrivingSoonSeconds { return "잠시후" }
    let minutes = seconds / 60
    let rest = seconds % 60
    if minutes >= 60 { return "\(minutes / 60)시간 \(minutes % 60)분" }
    return rest == 0 ? "\(minutes)분" : "\(minutes)분 \(rest)초"
  }

  private static func formatObservedAt(_ ms: Int64) -> String {
    let parts = Calendar.current.dateComponents(
      [.hour, .minute],
      from: Date(timeIntervalSince1970: Double(ms) / 1000)
    )
    return String(format: "%02d:%02d 기준", parts.hour ?? 0, parts.minute ?? 0)
  }
}
