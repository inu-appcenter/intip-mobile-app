# 채팅 알림 고도화 — 현황 조사 및 이슈 리스트업

> 작성: 2026-09-16 / 발단: 팀 채팅 스레드("카톡처럼 무음 알림 설정 시 소리·진동·팝업
> 없이 알림센터에만 쌓이게", "지금은 알림 아예 끄기 아니면 완전 켜기밖에 없다")
>
> 이 문서는 **구현이 아니라 현황 정리 + 이슈 목록**이다. 코드 변경은 없다.

## 0. 세 줄 요약

1. **안드로이드는 이미 뼈대가 있다.** `chat_channel_muted`(LOW) 채널이 있고 서버가
   보내는 `data.muted === "true"`로 채널을 고른다. 다만 **채널 immutability** 함정과
   전달 지연(우선순위) 문제가 남아 있다.
2. **iOS는 사실상 무음 알림이 없다.** `muted`일 때 `sound`만 빼고 있어 배너는 그대로
   뜬다. iOS 15+ `interruption-level: passive`를 안 쓴다. 게다가 백그라운드/종료
   상태에서는 APNs가 직접 렌더하므로 **서버 페이로드 없이는 클라가 손댈 수 없다.**
3. **"무음"의 사용자 설정 자체가 어디에도 없다.** `muted`는 서버가 내려주는 플래그일
   뿐, 그 값을 정하는 설정 화면·저장소·계약이 문서화돼 있지 않다. hyunjun이 말한
   "아예 끄기 아니면 완전 켜기" 문제의 본체는 여기다.

---

## 1. 현재 구현 (사실 확인)

### 클라이언트 (`src/push/messaging.ts`)

| 항목 | 상태 |
|---|---|
| Android 채널 | `default`(HIGH) / `chat_channel_default`(HIGH) / `chat_channel_muted`(LOW) 3개, `ensureAndroidChannels()`에서 생성 |
| 무음 분기 | `data.muted === 'true'` → 안드로이드는 muted 채널, iOS는 `sound` 생략만 |
| 채팅 그룹화 | Android `groupId`/`groupSummary`(2번째 메시지부터), iOS `threadId` |
| 그룹 요약 정리 | `pruneOrphanSummaries` / `pruneChatGroupSummary` / `clearChatGroup` |
| 탭 라우팅 | `resolveNavIntent` + `pendingIntent` 큐 + 8슬롯 중복 억제 |
| 권한 | Android 13+ `POST_NOTIFICATIONS`, iOS alert+badge+sound 일괄 요청 |
| 발송 형태 | **채팅은 안드로이드에서 data-only**(그래야 백그라운드에서 그룹화 코드가 돈다), 그 외에는 `notification`+`data` |

### 서버 계약 (`docs/push-notification-routing/plan.md`)

```jsonc
{
  "notification": { "title": "…", "body": "…" },
  "data": { "type": "GENERAL|CHAT|SCHOOL_NOTICE|DEPARTMENT|FRIEND",
            "path": "…", "targetId": "…", "noticeId": "…", "chatRoomId": "…" }
}
```

`muted`, `chatRoomName`, `messageText`는 **코드가 읽고 있는데 이 계약 문서에는 없다.**

---

## 2. 이슈 리스트

### 🔴 P0 — 무음 알림이 실제로 동작하지 않는 구간

#### [C-1] iOS 무음 알림에 `interruption-level: passive`가 없다 (클라)
`messaging.ts`의 iOS 분기는 `muted`일 때 `sound`만 뺀다. 소리는 없지만 **배너가 화면
위로 튀어나오고 화면이 켜진다** — 카톡식 무음(알림센터에만 조용히 쌓임)이 아니다.
- 필요: `ios.interruptionLevel: 'passive'`(notifee 지원 확인됨,
  `IOSNotificationInterruptionLevel = 'active'|'critical'|'passive'|'timeSensitive'`)
- 범위: `handleDisplayNotification()` iOS 분기
- 참고: 이 경로는 **포그라운드 수신에만** 적용된다. 백그라운드는 S-1 참조.

#### [S-1] iOS 백그라운드/종료 상태 무음은 서버 페이로드로만 가능 (서버)
iOS는 `notification` 블록을 동봉해 보내므로 앱이 죽어 있을 때 알림을 그리는 주체는
APNs다. 클라 코드가 개입할 수 없다. 서버가 APNs 설정을 내려야 한다.
```jsonc
"apns": {
  "headers": { "apns-push-type": "alert", "apns-priority": "5" },  // 무음은 5
  "payload": { "aps": {
    "alert": { "title": "…", "body": "…" },
    "interruption-level": "passive",   // 무음일 때만
    // "sound" 키 자체를 생략          // 무음일 때만
    "thread-id": "<chatRoomId>",       // 방별 그룹화 (지금은 포그라운드만 됨)
    "badge": <unread>
  } }
}
```
- gang_03이 말한 "페이로드만 바꾸면"이 정확히 이 항목.
- 대안(비추): NSE(Notification Service Extension)를 붙여 클라에서 재가공 — 타깃 추가 +
  네이티브 재빌드 비용이 크고, `passive`는 NSE로도 못 바꾼다. **서버 수정이 정답.**

#### [S-2] 무음 여부를 정하는 사용자 설정이 없다 (서버 + 웹)
`muted`는 서버가 내려주는 결과값일 뿐, 그 값을 결정하는 설정이 없다.
필요한 것:
- 채팅방별 알림 끄기(무음) 토글 — 카톡의 "알림 끄기"
- 전체 무음 모드 / 방해금지 시간대(선택)
- 저장 위치: 서버(멤버×채팅방) — 기기 간 동기화 필요하므로 로컬 저장은 부적절
- 노출 위치: 포털 웹(채팅방 상세 / 설정) — **웹팀 확인 필요**
- 발송 시점에 서버가 이 설정을 읽어 `data.muted`와 APNs `interruption-level`을 결정

---

### 🟠 P1 — 잠재적 오동작 / 신뢰성

#### [C-2] Android 알림 채널은 생성 후 설정 변경이 반영되지 않는다 (클라)
`createChannel()`은 같은 id로 다시 불러도 **importance/sound/vibration을 덮어쓰지
못한다**(사용자가 직접 낮춘 값 보호). 이미 출시된 빌드에서 `chat_channel_muted`를
만든 기기는, 나중에 우리가 채널 설정을 고쳐도 **영원히 예전 설정으로 동작**한다.
- 지금 바꾸려면 채널 id를 versioning 해야 한다 (`chat_channel_muted_v2`) + 구 채널 삭제
- 무음 스펙을 확정하기 **전에** 채널 설정을 못 박아 두는 게 중요
- 덤: muted 채널에 `vibration: false`, `lights: false`가 명시돼 있지 않다(LOW라 실제로는
  안 울리지만, 채널 설정은 한 번 굳으면 못 고치므로 지금 명시해 두는 게 안전)

#### [S-3] 안드로이드 data-only 채팅 푸시의 우선순위 (서버)
채팅은 안드로이드에서 data-only로 오는데, data-only 메시지는 `android.priority: "high"`가
아니면 **Doze/앱 대기 버킷에서 지연되거나 묶여서 온다.** 채팅에서는 치명적.
- 필요: 소리 나는 채팅 = `android.priority: "high"`
- 무음 채팅 = `"normal"`로 내려도 되는가? → **지연 허용 여부를 제품 결정으로 확정 필요.**
  카톡은 무음이어도 즉시 도착한다. 즉시성이 필요하면 무음도 `high`로 보내고 채널로만
  조용하게 만들어야 한다.

#### [C-3] 그룹 요약(summary)의 무음 처리가 검증되지 않았다 (클라)
`groupAlertBehavior: CHILDREN`로 자식만 알리게 돼 있는데, muted 채널의 자식은 애초에
알리지 않는다. 이 조합에서 요약이 조용한지, 혹은 요약이 대신 알리는지 **실기기 확인 필요.**

#### [C-4] 무음 경로에 테스트가 하나도 없다 (클라)
`src/push/__tests__/`에 `muted`를 다루는 케이스가 0건이다(`chatGroupSummary.test.ts`,
`navIntent`, `navPath`, `pendingIntent`만 존재). 채널 선택·iOS 옵션 분기는 순수 로직으로
떼어낼 수 있으므로 단위 테스트 가능.

#### [C-5] iOS 포그라운드 표시 옵션에 muted 분기가 없다 (클라)
`ios.foregroundPresentationOptions`를 지정하지 않아 기본값(배너 표시)을 쓴다.
무음이면 `{ banner: false, list: true, sound: false, badge: true }`가 맞다.

---

### 🟡 P2 — 정합성 / 문서

#### [D-1] 서버 계약 문서가 현실과 어긋나 있다
- `docs/push-notification-routing/guide-corrections.md`는 **"data-only 전환 금지"**를
  강하게 못 박고 있는데, 실제로는 **채팅이 안드로이드에서 data-only로 전환됐다.**
  그대로 두면 서버팀이 문서를 근거로 잘못 판단한다.
- `plan.md`의 "서버가 보내는 것 (확정)"에 `muted` / `chatRoomName` / `messageText` /
  `fcmMessageId` / `notificationType` / `campaignId` / `sentAt`가 빠져 있다.
  (코드는 전부 읽고 있다.)
- → 계약 문서를 현재 코드 기준으로 재작성해야 한다.

#### [P-1] 무음의 정의를 제품 차원에서 확정해야 한다
"무음"이 무엇을 끄는지 합의가 없다. 카톡 기준으로 옵션을 나열하면:

| 단계 | 소리 | 진동 | 헤드업 팝업 | 알림센터 | 배지 |
|---|---|---|---|---|---|
| 전체 켜기 | O | O | O | O | O |
| **무음(카톡 "알림 끄기")** | X | X | X | **O** | O 또는 X |
| 완전 끄기 | X | X | X | X | X |

- 무음일 때 **배지 카운트는 올릴 것인가?** (카톡은 올린다)
- 무음일 때 **잠금화면에 보일 것인가?** (Android LOW는 보인다 / iOS passive도 보인다)
- 방해금지 시간대를 1차 범위에 넣을 것인가?

#### [C-6] 알림 권한 요청 시점
`_layout.tsx`가 앱 시작 직후 `requestNotificationPermission()`을 무조건 호출한다.
첫 실행에서 맥락 없이 권한 팝업이 뜬다 — 알림 설정 화면을 만드는 김에 함께 개선 후보.

---

## 3. 권장 처리 순서

1. **[P-1] 무음 정의 확정** — 이게 없으면 [C-2] 채널 설정을 못 박을 수 없다.
2. **[S-2] 설정 저장·노출 위치 확정** (서버 + 웹팀)
3. **[S-1] iOS APNs 페이로드 / [S-3] Android priority 확정** (서버)
4. **[C-2] 채널 id versioning 포함해 클라 구현** ([C-1] [C-5] [C-3] 동시)
5. **[C-4] 테스트 + 실기기 QA**(포그라운드/백그라운드/종료 × iOS/Android × 무음/일반 = 12케이스)
6. **[D-1] 계약 문서 갱신**

## 4. 팀별 액션

- **서버**: S-1(APNs interruption-level/sound/thread-id), S-2(설정 API), S-3(priority)
- **웹**: S-2(채팅방별 알림 설정 UI 노출 위치)
- **앱**: C-1 ~ C-6
- **제품/기획**: P-1(무음 정의), S-3의 무음 즉시성 여부
