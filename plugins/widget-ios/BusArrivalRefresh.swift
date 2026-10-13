// Copied into the ExpoWidgetsTarget by plugins/withBusArrivalRefreshIntent.js.
// /ios is prebuild output; edit this file, not the copy under ios/.
//
// In-place refresh for the two bus home screen widgets — 인입런 · 가까운 정류장
// (BusArrivalWidget) and 인입런 · 정류장 선택 (BusStopWidget).
//
// A WidgetKit button runs its intent in the widget extension, in the
// background, without opening the app — and the reload that follows a tap
// doesn't count against WidgetKit's daily reload budget. That makes a tap the
// one way an iOS widget can show a fresh bus estimate on demand.
//
// expo-widgets' own `Button` can't be used for this: it always maps to its
// `WidgetUserInteraction` intent, which only re-evaluates the layout's press
// handler (a pure JSContext with no network) and pings the app if it happens
// to be running. So this file supplies its own intents, and the plugin puts a
// tap target over the refresh icon the layout already draws in its
// bottom-trailing corner.
//
// The fetch and the snapshot it writes are a Swift port of the app's
// `refreshBusArrivalWidget` / `refreshBusStopWidget` (src/widgets/refresh.ts)
// and the pure functions they use in src/widgets/data/busArrival.ts —
// `withObservedAt`, `arrivalsForStop`, `earliestArrivals`,
// `arrivalBoundariesOf`, `toBusArrivalProps`. Keep the two in step. What it
// deliberately does not port is choosing the stops: the nearest one needs the
// user's location, which the extension doesn't have, and the selectable ones
// take their labels and routes from an API the app has already read. So it
// reuses the `source` the app writes into every entry's props. Without one —
// the app has never refreshed this widget — a tap does nothing.

import AppIntents
import SwiftUI
import WidgetKit
internal import ExpoWidgets

private let nearestWidgetName = "BusArrivalWidget"
private let stopWidgetName = "BusStopWidget"

@available(iOS 17.0, *)
extension View {
  /** Adds the refresh tap target over the layout's refresh icon. */
  func busRefreshOverlay<Refresh: AppIntent>(_ intent: Refresh) -> some View {
    self
      // Dims the content while a tap's refresh is running — the only
      // progress feedback a widget can give.
      .invalidatableContent()
      .overlay(alignment: .bottomTrailing) {
        // 44pt is the minimum tap target; the layout's icon is 12pt, inset
        // 16pt from both edges, so this square covers it with room to spare.
        // A Button in a widget takes its area away from `widgetURL`, so the
        // rest of the widget still opens the app.
        Button(intent: intent) {
          Color.clear
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("버스 도착 정보 새로고침")
      }
  }

  /**
   * For BusStopWidget, whose entry view expo-widgets generates per widget (it
   * carries the configuration), so the plugin appends this to it rather than
   * swapping the view out.
   */
  func busStopRefreshOverlay() -> some View {
    busRefreshOverlay(RefreshBusStopIntent())
  }
}

/** BusArrivalWidget's entry view: the generated one, with the refresh tap target added. */
struct BusArrivalEntryView: View {
  let entry: WidgetsTimelineEntry

  var body: some View {
    if #available(iOS 17.0, *) {
      WidgetsEntryView(entry: entry).busRefreshOverlay(RefreshBusArrivalIntent())
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
    WidgetCenter.shared.reloadTimelines(ofKind: nearestWidgetName)
    return .result()
  }
}

@available(iOS 17.0, *)
struct RefreshBusStopIntent: AppIntent {
  static var title: LocalizedStringResource = "인입런 정류장 새로고침"
  static var isDiscoverable: Bool = false

  init() {}

  func perform() async throws -> some IntentResult {
    await BusArrivalRefresh.runStops(now: Date())
    WidgetCenter.shared.reloadTimelines(ofKind: stopWidgetName)
    return .result()
  }
}

enum BusArrivalRefresh {
  /** Mirrors `ARRIVING_SOON_SECONDS` in busArrival.ts. */
  static let arrivingSoonSeconds = 60

  /** Mirrors `REQUEST_TIMEOUT_MS` in apiClient.ts. */
  static let requestTimeout: TimeInterval = 10

  /** Mirrors `BUS_STOP_ARRIVALS_KEPT` in refresh.ts. */
  static let stopArrivalsKept = 4

  private static func timelineKey(_ widgetName: String) -> String { "__expo_widgets_\(widgetName)_timeline" }

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
          let items = await fetchArrivals(apiBaseUrl: source.apiBaseUrl, bstopId: source.bstopId) else {
      return
    }

    let nowMs = Int64((now.timeIntervalSince1970 * 1000).rounded())
    let arrivals = withObservedAt(arrivalsForStop(items, routeIds: source.routeIds), fetchedAtMs: nowMs)
    let moments = [nowMs] + arrivalBoundaries(arrivals, nowMs: nowMs)
    let entries: [[String: Any]] = moments.map { at in
      var props = snapshot(arrivals, stopLabel: source.stopLabel, atMs: at)
      props["source"] = source.dictionary
      return ["timestamp": Int(at), "props": props]
    }
    defaults.set(entries, forKey: timelineKey(nearestWidgetName))
  }

  /**
   * The same for BusStopWidget: refetches every selectable stop and rewrites
   * the one timeline they share. All of them rather than the one this widget
   * shows — a single timeline feeds every placed copy, and nine small requests
   * on a tap is cheaper to get right than merging one stop into the rest.
   *
   * A stop whose request fails keeps what the existing timeline had for it.
   */
  static func runStops(now: Date) async {
    guard let defaults, let source = currentStopSource(defaults) else { return }

    var fetched: [String: [Item]] = [:]
    await withTaskGroup(of: (String, [Item]?).self) { group in
      for stop in source.stops {
        group.addTask { (stop.id, await fetchArrivals(apiBaseUrl: source.apiBaseUrl, bstopId: stop.bstopId)) }
      }
      for await (id, items) in group {
        if let items { fetched[id] = items }
      }
    }
    if fetched.isEmpty { return }

    let nowMs = Int64((now.timeIntervalSince1970 * 1000).rounded())
    var arrivalsById: [String: [Item]] = [:]
    for stop in source.stops {
      guard let items = fetched[stop.id] else { continue }
      let pinned = withObservedAt(arrivalsForStop(items, routeIds: stop.routeIds), fetchedAtMs: nowMs)
      arrivalsById[stop.id] = earliestArrivals(pinned, nowMs: nowMs, count: stopArrivalsKept)
    }

    // The existing entries, for the stops that failed: their snapshots are
    // carried over, at the moments they were already going to change.
    let existing: [(at: Int64, stops: [String: Any])] = (defaults.array(forKey: timelineKey(stopWidgetName)) as? [[String: Any]] ?? [])
      .compactMap { entry in
        guard let timestamp = (entry["timestamp"] as? NSNumber)?.int64Value,
              let props = entry["props"] as? [String: Any],
              let stops = props["stops"] as? [String: Any] else {
          return nil
        }
        return (timestamp, stops)
      }
      .sorted { $0.at < $1.at }
    let carriedOver = source.stops.contains { arrivalsById[$0.id] == nil }

    var instants = Set<Int64>()
    for arrivals in arrivalsById.values {
      instants.formUnion(arrivalBoundaries(arrivals, nowMs: nowMs))
    }
    if carriedOver {
      instants.formUnion(existing.map(\.at).filter { $0 > nowMs })
    }

    let entries: [[String: Any]] = ([nowMs] + instants.sorted()).map { at in
      var stops: [String: Any] = [:]
      for stop in source.stops {
        if let arrivals = arrivalsById[stop.id] {
          stops[stop.id] = snapshot(arrivals, stopLabel: stop.stopLabel, atMs: at)
        } else {
          let previous = existing.last { $0.at <= at } ?? existing.first
          stops[stop.id] = previous?.stops[stop.id] ?? ["status": "noData"]
        }
      }
      return ["timestamp": Int(at), "props": ["stops": stops, "source": source.dictionary] as [String: Any]]
    }
    defaults.set(entries, forKey: timelineKey(stopWidgetName))
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
    let timeline = defaults.array(forKey: timelineKey(nearestWidgetName)) as? [[String: Any]] ?? []
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

  /** `BusStopRefreshSource` in BusArrivalWidget.tsx. */
  struct StopSource {
    struct Stop {
      let id: String
      let bstopId: String
      let stopLabel: String
      let routeIds: [String]
    }

    let apiBaseUrl: String
    let stops: [Stop]

    var dictionary: [String: Any] {
      [
        "apiBaseUrl": apiBaseUrl,
        "stops": stops.map { stop -> [String: Any] in
          ["id": stop.id, "bstopId": stop.bstopId, "stopLabel": stop.stopLabel, "routeIds": stop.routeIds]
        },
      ]
    }
  }

  private static func currentStopSource(_ defaults: UserDefaults) -> StopSource? {
    let timeline = defaults.array(forKey: timelineKey(stopWidgetName)) as? [[String: Any]] ?? []
    for entry in timeline {
      guard let props = entry["props"] as? [String: Any],
            let raw = props["source"] as? [String: Any],
            let apiBaseUrl = raw["apiBaseUrl"] as? String,
            let rawStops = raw["stops"] as? [[String: Any]] else {
        continue
      }
      let stops: [StopSource.Stop] = rawStops.compactMap { stop in
        guard let id = stop["id"] as? String,
              let bstopId = stop["bstopId"] as? String,
              let stopLabel = stop["stopLabel"] as? String else {
          return nil
        }
        return StopSource.Stop(id: id, bstopId: bstopId, stopLabel: stopLabel, routeIds: stop["routeIds"] as? [String] ?? [])
      }
      if !stops.isEmpty { return StopSource(apiBaseUrl: apiBaseUrl, stops: stops) }
    }
    return nil
  }

  // MARK: - Fetch

  struct Item: Sendable {
    let routeId: String?
    let routeNo: String?
    let etaSeconds: Double?
    var observedAtMs: Int64?
  }

  private static func fetchArrivals(apiBaseUrl: String, bstopId: String) async -> [Item]? {
    guard var components = URLComponents(string: "\(apiBaseUrl)/api/buses/arrivals") else {
      return nil
    }
    components.queryItems = [URLQueryItem(name: "bstopId", value: bstopId)]
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

  /** `earliestArrivals` in busArrival.ts. */
  private static func earliestArrivals(_ items: [Item], nowMs: Int64, count: Int) -> [Item] {
    let upcoming: [(arrivesAt: Int64, item: Item)] = items.compactMap { item in
      guard let at = arrivesAt(item, nowMs: nowMs), at > nowMs else { return nil }
      return (at, item)
    }
    return upcoming.sorted { $0.arrivesAt < $1.arrivesAt }.prefix(count).map(\.item)
  }

  /** `toBusArrivalProps` in busArrival.ts: one stop's snapshot as of `atMs`. */
  private static func snapshot(_ items: [Item], stopLabel: String, atMs: Int64) -> [String: Any] {
    let known: [(route: String, arrivesAt: Int64, observedAt: Int64)] = items.compactMap { item in
      guard let route = trimmedRoute(item), let arrivesAt = arrivesAt(item, nowMs: atMs) else { return nil }
      return (route, arrivesAt, item.observedAtMs ?? atMs)
    }

    let rows: [(arrivesAt: Int64, row: [String: Any])] = known.compactMap { bus in
      let remaining = Int((Double(bus.arrivesAt - atMs) / 1000).rounded())
      if remaining <= 0 { return nil }
      return (bus.arrivesAt, [
        "route": bus.route,
        "eta": formatEta(remaining),
        "soon": remaining <= arrivingSoonSeconds,
        "arrivesAt": bus.arrivesAt,
        "observedLabel": formatObservedAt(bus.observedAt),
      ])
    }
    let shown = rows.sorted { $0.arrivesAt < $1.arrivesAt }.prefix(3).map(\.row)
    if !shown.isEmpty {
      return ["status": "normal", "stopLabel": stopLabel, "arrivals": shown]
    }

    // Buses that were on their way when this was read have all arrived: the
    // reading has run out, which is not "no buses".
    if let observedAt = known.filter({ $0.arrivesAt > $0.observedAt }).map(\.observedAt).max() {
      return ["status": "stale", "stopLabel": stopLabel, "observedLabel": formatObservedAt(observedAt)]
    }
    return ["status": "noData"]
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
