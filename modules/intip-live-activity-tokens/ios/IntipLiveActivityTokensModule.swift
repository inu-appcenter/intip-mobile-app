import ActivityKit
import ExpoModulesCore

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

/// 시간표 Live Activity마다 ActivityKit 업데이트 push 토큰을 JS로 넘긴다.
///
/// expo-widgets는 앱이 직접 `start()`한 Activity의 토큰만 알려 주고, 서버 push-to-start로 시작된
/// Activity는 관찰하지 않는다. 그 토큰이 있어야 서버가 수업 시작 때 "수업 중"으로 갱신하고 수업이
/// 끝나면 Activity를 끝낼 수 있다(앱이 꺼져 있어도). push-to-start로 Activity가 생기면 시스템이 앱을
/// 백그라운드로 잠깐 깨워 주므로, 그때 `activityUpdates`로 새 Activity를 받아 토큰을 넘긴다.
public class IntipLiveActivityTokensModule: Module {
  // 상태(activitiesTask, tokenTasks, lastTokens)는 모두 메인 액터에서만 만진다.
  private var activitiesTask: Task<Void, Never>?
  private var tokenTasks: [String: [Task<Void, Never>]] = [:]
  private var lastTokens: [String: Data] = [:]

  public func definition() -> ModuleDefinition {
    Name("IntipLiveActivityTokens")

    Events("onActivityPushToken")

    // 관찰은 한 번 시작하면 프로세스가 끝날 때까지 유지하고, 리스너가 다시 붙을 때마다 현재 토큰을
    // 다시 보낸다. 리스너가 붙었다 떨어졌다 하면(개발 빌드의 effect 재실행 등) start/stop이 메인 액터에서
    // 순서가 뒤바뀌어 관찰이 꺼진 채로 남을 수 있어서 stop에서는 아무것도 하지 않는다. 리스너가 없을 때
    // 보낸 이벤트는 버려질 뿐이다.
    OnStartObserving("onActivityPushToken") {
      Task { @MainActor [weak self] in
        self?.startObserving()
      }
    }
  }

  @MainActor
  private func startObserving() {
    guard #available(iOS 16.2, *) else { return }
    guard activitiesTask == nil else {
      // 다시 붙은 리스너에게 지금 떠 있는 Activity들의 토큰을 다시 보낸다.
      for activity in Activity<LiveActivityAttributes>.activities {
        if let token = lastTokens[activity.id] ?? activity.pushToken {
          emit(activity, token)
        }
      }
      rescan()
      return
    }
    rescan()
    activitiesTask = Task { @MainActor [weak self] in
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

  /// 떠 있는 Activity 중 아직 관찰하지 않는 것을 관찰하기 시작한다. 정적 목록(`activities`)은 같은 이름의
  /// 타입이 둘이어도 양쪽에서 다 보인다.
  @MainActor
  private func rescan() {
    guard #available(iOS 16.2, *) else { return }
    for activity in Activity<LiveActivityAttributes>.activities {
      observeTokens(of: activity)
    }
  }

  @available(iOS 16.2, *)
  @MainActor
  private func observeTokens(of activity: Activity<LiveActivityAttributes>) {
    let id = activity.id
    guard tokenTasks[id] == nil else { return }
    tokenTasks[id] = [
      Task { @MainActor [weak self] in
        if let token = activity.pushToken {
          self?.lastTokens[id] = token
          self?.emit(activity, token)
        }
        for await token in activity.pushTokenUpdates {
          self?.lastTokens[id] = token
          self?.emit(activity, token)
          self?.rescan()
        }
      },
      // 앱은 떠 있는 Activity를 다음 수업 내용으로 바꿔 쓰기도 한다. 토큰은 그대로라도 서버가 새 수업
      // 시각을 알아야 하므로 내용이 바뀔 때도 다시 알린다.
      Task { @MainActor [weak self] in
        for await _ in activity.contentUpdates {
          if let token = self?.lastTokens[id] ?? activity.pushToken {
            self?.emit(activity, token)
          }
        }
      },
    ]
  }

  @available(iOS 16.2, *)
  private func emit(_ activity: Activity<LiveActivityAttributes>, _ token: Data) {
    let state = activity.content.state
    sendEvent("onActivityPushToken", [
      "activityId": activity.id,
      "pushToken": token.map { String(format: "%02x", $0) }.joined(),
      "name": state.name,
      "props": state.props
    ])
  }
}
