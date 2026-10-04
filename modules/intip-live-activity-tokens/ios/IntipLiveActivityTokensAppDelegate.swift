import ActivityKit
import ExpoModulesCore

/// 앱 실행 직후 Live Activity 토큰 관찰을 시작한다.
///
/// 서버 push-to-start로 Activity가 생기면 시스템이 앱을 백그라운드로 실행하는데, 아무것도 붙잡지 않으면
/// JS가 뜨기도 전에 곧 일시정지된다. 그래서 백그라운드 실행이고 Activity가 떠 있으면 실행 시간을 확보해
/// JS가 토큰을 서버에 등록할 수 있게 한다.
public class IntipLiveActivityTokensAppDelegate: ExpoAppDelegateSubscriber {
  /// JS 번들 로드 + 로그인 토큰 갱신 + 등록 요청에 충분하면서, 시스템 한도(약 30초) 안쪽.
  private static let backgroundWorkTimeout: TimeInterval = 25

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    guard #available(iOS 16.2, *) else { return true }
    let observer = LiveActivityTokenObserver.shared
    if application.applicationState == .background && !Activity<LiveActivityAttributes>.activities.isEmpty {
      observer.beginBackgroundWork(timeout: Self.backgroundWorkTimeout)
    }
    observer.start()
    return true
  }
}
