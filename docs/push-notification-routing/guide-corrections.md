# FCM 구현 가이드 오류 정정 회람문

> **대상**: 웹팀 / 서버팀
> **배경**: 서버 이슈 #271 / PR #272로 FCM `data`에 `path`(및 `type`,
> `targetId`, `noticeId`, `chatRoomId`)가 추가되면서, 앞서 회람된 클라이언트
> 구현 가이드에 담긴 예제 코드 2건에 오류가 있음을 확인했다. 이 문서는 그
> 오류를 정정하고, 이 앱(`intip-mobile-app`)이 실제로 구현한 방식을 근거와
> 함께 공유하기 위한 것이다.
>
> 상세 설계와 격차 분석은 이 레포의
> [`docs/push-notification-routing/plan.md`](./plan.md) "G6 — 가이드 정정"
> 섹션 참조. 이 문서는 그 내용을 웹/서버팀 회람용으로 정리한 것이다.
>
> **코드 변경 없음** — 이 앱은 아래 두 항목 모두 이미 올바르게 구현돼 있다
> (`src/push/messaging.ts`). 이 문서는 가이드 텍스트/예제만 정정 대상으로
> 삼는다.

---

## 오류 1. `messaging().getInitialMessage()`는 존재하지 않는 API

가이드에 다음과 같은 예제가 있었다:

```ts
// ❌ 잘못된 예 — RNFirebase에 이런 메서드가 없다
const initialMessage = await messaging().getInitialMessage();
```

`getInitialMessage()`는 **Flutter용 FlutterFire 패키지**(`firebase_messaging`
Dart 패키지)의 메서드 이름이다. React Native용 패키지인
`@react-native-firebase/messaging`에는 이 메서드가 없다. 실제 타입 정의
(`node_modules/@react-native-firebase/messaging/dist/typescript/lib/types/messaging.d.ts:394`)
를 확인하면 다음만 존재한다:

```ts
/**
 * When the application is opened from a quit state via a push notification,
 * this method will return a `RemoteMessage` containing the notification
 * data, or `null` if the app was opened via another method.
 */
getInitialNotification(): Promise<RemoteMessage | null>;
```

즉 React Native에서 올바른 이름은 **`getInitialNotification()`**이다.

### 올바른 사용 예시

```ts
// ✅ 콜드스타트(앱이 종료된 상태)에서 알림을 탭해 앱이 열린 경우
import messaging from '@react-native-firebase/messaging';

const remoteMessage = await messaging().getInitialNotification();
if (remoteMessage) {
  const { path, type, targetId } = remoteMessage.data ?? {};
  // path/type/targetId로 라우팅 인텐트를 계산해 사용
}
```

참고로 앱이 **백그라운드 상태**(종료는 아님)에서 알림을 탭해 포그라운드로
복귀한 경우는 별도 메서드인 `onNotificationOpenedApp()`을 쓴다. 이 앱은 두
경로를 모두 구현해 두었다(`src/push/messaging.ts`의
`getInitialNavIntent()` / `subscribeNotificationOpen()`).

---

## 오류 2. `onMessage` 예제가 수신 즉시 라우팅을 호출한다

가이드의 포그라운드 수신 예제는 다음과 같은 형태였다:

```ts
// ❌ 잘못된 예 — 알림이 도착하자마자(사용자가 탭하기도 전에) 화면을 이동시킨다
messaging().onMessage(async (remoteMessage) => {
  navigateTo(remoteMessage.data.path);
});
```

`onMessage`는 앱이 **포그라운드에 떠 있는 동안** 새 FCM 페이로드가 도착할
때마다 호출된다(사용자가 그 알림을 탭했는지 여부와 무관). 위 예제대로 구현하면
사용자가 다른 화면을 보고 있는 도중 알림이 하나 도착하는 즉시 그 화면이
강탈되어 알림이 가리키는 페이지로 강제 이동한다. 사용자가 아무 것도 탭하지
않았는데 현재 작업 컨텍스트를 잃는 것이므로 명백히 잘못된 동작이다.

포그라운드에서 알림이 도착했을 때 해야 할 일은 딱 하나, **로컬 알림(배너)을
표시하는 것**뿐이다. 실제 라우팅은 **사용자가 그 배너를 탭했을 때**만
일어나야 한다.

### 잘못된 예 vs 올바른 예

```ts
// ❌ 잘못된 예 — 수신 즉시 라우팅
messaging().onMessage(async (remoteMessage) => {
  navigateTo(remoteMessage.data.path);
});
```

```ts
// ✅ 올바른 예 — 수신 시에는 배너만, 라우팅은 탭 이벤트에서
import messaging from '@react-native-firebase/messaging';
import notifee, { EventType } from '@notifee/react-native';

// 1) 포그라운드 수신 → 배너 표시만 한다. 여기서 navigateTo를 호출하지 않는다.
messaging().onMessage(async (remoteMessage) => {
  await notifee.displayNotification({
    title: remoteMessage.notification?.title,
    body: remoteMessage.notification?.body,
    data: remoteMessage.data,
    android: { channelId: 'default', pressAction: { id: 'default' } },
  });
});

// 2) 사용자가 배너를 "탭"했을 때만 라우팅한다.
notifee.onForegroundEvent(({ type, detail }) => {
  if (type === EventType.PRESS) {
    navigateTo(detail.notification?.data?.path);
  }
});

// 3) 앱이 백그라운드 상태에서 열려 있던 알림을 탭한 경우도 별도로 처리한다
//    (수신 시점이 아니라 역시 "탭 이벤트"에서 라우팅).
messaging().onNotificationOpenedApp((remoteMessage) => {
  navigateTo(remoteMessage.data?.path);
});
```

이 앱은 위 올바른 패턴대로 이미 구현돼 있다
(`src/push/messaging.ts`의 `setupForegroundNotifications()` — 배너 표시만
하고 라우팅하지 않음, `subscribeNotificationOpen()` — 탭 이벤트에서만
라우팅). 코드 변경은 필요 없으며, 가이드 예제 쪽을 이 패턴으로 정정해 달라는
요청이다.

---

## 덧붙임: `notification` 블록을 계속 동봉해 달라 (data-only 전환 금지)

가이드 어딘가에서 "백그라운드/종료 상태 처리를 더 세밀하게 제어하려면
`data`-only 메시지로 보내고 클라이언트가 직접 알림을 그리게 하면 어떤가"라는
제안이 나올 수 있는데, **이 앱에서는 그렇게 바꾸면 안 된다.**

이 앱은 다음을 전제로 구현돼 있다:

- 서버가 보내는 FCM 페이로드에는 **항상 `notification` 블록이 동봉**된다
  (`plan.md` "서버가 보내는 것 (확정)" 참조: `data`-only 금지가 이미 명시돼
  있음).
- 앱이 **백그라운드 또는 종료 상태**일 때 알림 배너를 화면에 그리는 일은
  **OS(안드로이드 시스템 트레이 / iOS 알림 센터)가 FCM SDK를 통해 자동으로
  수행**한다. 클라이언트 코드가 직접 관여하지 않는다.
- 이 때문에 `src/push/messaging.ts`의 `setBackgroundMessageHandler`와
  `notifee.onBackgroundEvent`는 **의도적으로 빈 핸들러**다:

  ```ts
  // Data-only messages while backgrounded. The OS renders `notification`
  // payloads itself; nothing extra to do here, but the handler must exist.
  messaging().setBackgroundMessageHandler(async () => {});

  // Taps on notifee notifications while backgrounded are resolved on next
  // launch via getInitialNotification(); the handler just needs to exist.
  notifee.onBackgroundEvent(async () => {});
  ```

  두 핸들러 모두 **"존재해야만 한다"는 라이브러리 요구사항을 충족시키는
  용도**이지, 실제로 알림을 그리는 로직이 들어있지 않다. 백그라운드/종료
  상태의 알림 렌더링은 전적으로 OS와 `notification` 블록에 의존한다.

**만약 서버팀이 `data`-only 발송(= `notification` 블록 없이 `data`만)으로
바꾸면 다음이 깨진다**:

1. **백그라운드/종료 상태에서 알림이 아예 화면에 뜨지 않는다.** OS는
   `notification` 블록이 있어야 자동으로 배너/트레이 알림을 그린다.
   `data`-only 메시지는 OS가 아무것도 그리지 않고 조용히
   `setBackgroundMessageHandler`(현재 빈 함수)로만 전달되므로, 클라이언트가
   그 안에서 `notifee.displayNotification()` 등을 직접 호출하도록 전면
   재작성해야 한다.
2. iOS는 이런 background data 메시지 자체가 OS 정책(백그라운드 실행 시간
   제한, 사용자 저전력 모드 등)에 따라 **전달이 지연되거나 아예 드롭될 수
   있다** — `notification` 블록이 있는 메시지보다 신뢰도가 낮다.
3. 이 앱의 G4(백그라운드 notifee 탭 유실 수정 예정) 설계 전체가
   "OS가 백그라운드 알림 렌더링을 담당한다"는 전제 위에 있다. 이 전제가
   깨지면 알림 큐잉·중복 억제 로직을 다시 설계해야 한다.

**정리**: 서버는 계속 `notification` + `data` 블록을 **함께** 보내야 하며,
`data`-only로 전환하는 것은 백그라운드/종료 상태의 알림 표시 자체를 무너뜨리므로
검토 대상이 아니다.

---

## 요약

| 항목 | 가이드의 오류 | 정정 |
|---|---|---|
| API 이름 | `messaging().getInitialMessage()` | `messaging().getInitialNotification()` |
| `onMessage` 처리 | 수신 즉시 `navigateTo(data.path)` 호출 | 수신 시 로컬 알림(배너)만 표시, 라우팅은 탭 이벤트(`notifee.onForegroundEvent`/`onNotificationOpenedApp`)에서만 |
| 발송 방식 | (제안 시) `data`-only 전환 | 계속 `notification` + `data` 동봉 유지 — data-only는 백그라운드/종료 알림 표시를 깨뜨림 |

문의 사항이나 이견이 있으면 이 레포의
`docs/push-notification-routing/plan.md` / `issue.md`(서버 이슈 #271 / PR #272
스레드)에서 논의해 달라.
