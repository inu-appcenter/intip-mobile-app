import ActivityKit
import UIKit

/// expo-widgets의 ActivityAttributes와 같은 이름·모양.
///
/// ActivityKit은 Activity의 속성 타입을 (모듈과 무관하게) 타입 이름으로 식별한다 — push 페이로드의
/// `attributes-type: "LiveActivityAttributes"`가 expo-widgets 내부 타입과 맞물리는 것과 같은 규칙이다.
/// 그래서 여기서도 expo-widgets가 시작한 것과 서버 push-to-start로 시작된 것을 모두 볼 수 있다.
/// expo-widgets(WidgetLiveActivity.swift)의 정의가 바뀌면 같이 바꿔야 한다.
struct LiveActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var name: String
    var props: String
  }
}

/// 시간표 Live Activity마다 ActivityKit 업데이트 push 토큰을 관찰한다. 상태는 메인 액터에서만 만진다.
///
/// JS가 뜨기 전부터(앱 실행 직후) 관찰을 시작해야 한다. push-to-start로 Activity가 생기면 시스템이 앱을
/// 백그라운드로 실행해 토큰을 넘겨주는데, 그때 ActivityKit에 연결돼 있지 않으면 토큰을 놓치고 앱은 곧
/// 일시정지된다(시뮬레이터 Release 빌드에서 확인). 그래서 AppDelegate 단계에서 시작하고, 받은 토큰은
/// JS 리스너가 붙을 때 다시 보낸다.
@MainActor
final class LiveActivityTokenObserver {
  static let shared = LiveActivityTokenObserver()

  /// 모듈이 JS로 넘기는 콜백. 리스너가 없을 때 받은 토큰은 `lastTokens`에 남아 `replay()`로 다시 간다.
  var onToken: ((ActivityTokenSnapshot) -> Void)?

  private var started = false
  private var streamsTask: Task<Void, Never>?
  private var tokenTasks: [String: [Task<Void, Never>]] = [:]
  private var lastTokens: [String: Data] = [:]
  private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

  private init() {}

  /// 여러 번 불러도 한 번만 시작한다.
  func start() {
    guard #available(iOS 16.2, *) else { return }
    rescan()
    guard !started else { return }
    started = true
    streamsTask = Task { @MainActor [weak self] in
      await withTaskGroup(of: Void.self) { group in
        group.addTask { @MainActor [weak self] in
          for await _ in Activity<LiveActivityAttributes>.activityUpdates {
            self?.rescan()
          }
        }
        // 같은 이름의 ActivityAttributes가 expo-widgets에도 있어서 새 Activity 알림(activityUpdates)이
        // 이 타입으로는 오지 않는 경우가 있다(시뮬레이터에서 확인). 새 Activity의 토큰이 발급되면 앱의
        // push 토큰 집합이 바뀌며 이 스트림도 다시 흐르므로, 그때 목록을 다시 훑어 놓친 Activity를 잡는다.
        if #available(iOS 17.2, *) {
          group.addTask { @MainActor [weak self] in
            for await _ in Activity<LiveActivityAttributes>.pushToStartTokenUpdates {
              self?.rescan()
            }
          }
        }
      }
    }
  }

  /// 지금 떠 있는 Activity들의 마지막 토큰을 콜백으로 다시 보낸다(리스너가 새로 붙었을 때).
  func replay() {
    guard #available(iOS 16.2, *) else { return }
    for activity in Activity<LiveActivityAttributes>.activities {
      if let token = lastTokens[activity.id] ?? activity.pushToken {
        deliver(activity, token)
      }
    }
  }

  /// 백그라운드로 실행됐을 때 JS가 뜨고 토큰을 서버에 등록할 시간을 확보한다. 끝나면 `finishBackgroundWork()`,
  /// 아니면 시스템이 만료시킬 때 정리된다.
  func beginBackgroundWork(timeout: TimeInterval) {
    guard backgroundTask == .invalid else { return }
    backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "LiveActivityTokenSync") { [weak self] in
      Task { @MainActor in self?.finishBackgroundWork() }
    }
    Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
      self?.finishBackgroundWork()
    }
  }

  func finishBackgroundWork() {
    guard backgroundTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(backgroundTask)
    backgroundTask = .invalid
  }

  @available(iOS 16.2, *)
  private func rescan() {
    for activity in Activity<LiveActivityAttributes>.activities {
      observeTokens(of: activity)
    }
  }

  @available(iOS 16.2, *)
  private func observeTokens(of activity: Activity<LiveActivityAttributes>) {
    let id = activity.id
    guard tokenTasks[id] == nil else { return }
    tokenTasks[id] = [
      Task { @MainActor [weak self] in
        if let token = activity.pushToken {
          self?.lastTokens[id] = token
          self?.deliver(activity, token)
        }
        for await token in activity.pushTokenUpdates {
          self?.lastTokens[id] = token
          self?.deliver(activity, token)
          self?.rescan()
        }
      },
      // 앱은 떠 있는 Activity를 다음 수업 내용으로 바꿔 쓰기도 한다. 토큰은 그대로라도 서버가 새 수업
      // 시각을 알아야 하므로 내용이 바뀔 때도 다시 알린다.
      Task { @MainActor [weak self] in
        for await _ in activity.contentUpdates {
          if let token = self?.lastTokens[id] ?? activity.pushToken {
            self?.deliver(activity, token)
          }
        }
      },
    ]
  }

  @available(iOS 16.2, *)
  private func deliver(_ activity: Activity<LiveActivityAttributes>, _ token: Data) {
    let state = activity.content.state
    onToken?(ActivityTokenSnapshot(
      activityId: activity.id,
      pushToken: token.map { String(format: "%02x", $0) }.joined(),
      name: state.name,
      props: state.props
    ))
  }
}

struct ActivityTokenSnapshot {
  let activityId: String
  let pushToken: String
  let name: String
  let props: String
}
