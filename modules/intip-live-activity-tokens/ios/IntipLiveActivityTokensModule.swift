import ExpoModulesCore

/// 시간표 Live Activity마다 ActivityKit 업데이트 push 토큰을 JS로 넘긴다.
///
/// expo-widgets는 앱이 직접 `start()`한 Activity의 토큰만 알려 주고, 서버 push-to-start로 시작된
/// Activity는 관찰하지 않는다. 그 토큰이 있어야 서버가 수업 시작 때 "수업 중"으로 갱신하고 수업이
/// 끝나면 Activity를 끝낼 수 있다(앱이 꺼져 있어도). 관찰 자체는 `LiveActivityTokenObserver`가 앱 실행
/// 직후부터 하고, 여기서는 JS로 전달만 한다.
public class IntipLiveActivityTokensModule: Module {
  public func definition() -> ModuleDefinition {
    Name("IntipLiveActivityTokens")

    Events("onActivityPushToken")

    // 리스너가 붙을 때마다 지금까지 받은 토큰을 다시 보낸다. 리스너가 붙었다 떨어졌다 해도(개발 빌드의
    // effect 재실행 등) 마지막 리스너가 반드시 받도록 stop에서는 아무것도 하지 않는다.
    OnStartObserving("onActivityPushToken") {
      Task { @MainActor [weak self] in
        let observer = LiveActivityTokenObserver.shared
        observer.onToken = { [weak self] snapshot in
          self?.sendEvent("onActivityPushToken", [
            "activityId": snapshot.activityId,
            "pushToken": snapshot.pushToken,
            "name": snapshot.name,
            "props": snapshot.props
          ])
        }
        observer.start()
        observer.replay()
      }
    }

    /// JS가 토큰을 서버에 등록했으면 백그라운드 실행 시간을 일찍 돌려준다.
    Function("finishBackgroundWork") {
      Task { @MainActor in
        LiveActivityTokenObserver.shared.finishBackgroundWork()
      }
    }
  }
}
