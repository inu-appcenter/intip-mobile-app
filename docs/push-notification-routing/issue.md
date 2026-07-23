# ✨ feat: FCM 알림 탭 시 의도된 페이지로 이동 (클라이언트)

> 이 레포(`intip-mobile-app`)에 GitHub 이슈로 등록할 초안. 서버 레포 이슈
> **#271**(KimWash, "알림 탭 기능 구현을 위한 FCM 페이로드 추가") / **PR #272**의
> 클라이언트 대응 작업이다. 상세 설계·진행 상태는 같은 폴더의
> [`plan.md`](./plan.md) 참조.

## 📄 설명

서버가 FCM `data` 블록에 `path`(및 `type`/`targetId`/`noticeId` 등)를 추가한다
(#271). 앱은 알림을 탭했을 때 그 정보를 읽어 root SPA 라우팅 / 네이티브
sub-page push / 외부 브라우저 중 알맞은 방식으로 의도된 화면에 진입해야 한다.

기존 코드(`src/push/messaging.ts`, `src/push/navPath.ts`)에 배선은 이미 있었지만
점검 결과 다음 7개 격차/결함이 있었다(`plan.md` "격차/결함" 섹션 상세):

- **G1** 외부 URL(학교/학과 공지) 알림이 통째로 버려짐
- **G2** 콜드스타트(앱 종료 상태) 탭 시 딥링크가 레이스로 유실
- **G3** 목적지가 항상 root SPA로만 가서 비-메인탭(채팅 등) 라우팅이 깨짐
- **G4** 백그라운드에서 notifee 알림 탭이 유실
- **G5** Android 백그라운드 알림이 잘못된 채널로 표시
- **G6** 공유된 구현 가이드의 API명 오류 + 위험한 예제(수신 즉시 라우팅)
- **G7** 같은 목적지를 연속으로 탭하면 두 번째부터 무시됨

## ✅ 작업할 내용

- [x] **G1**: 외부 URL(학교 홈페이지 등) 알림 → 인앱 브라우저(`expo-web-browser`)로
      열기. Allowlist(`PUSH_EXTERNAL_HOSTS`, 서브도메인 포함) 기반. — 완료
- [x] **G2**: 콜드스타트 딥링크 유실 수정 (host 레벨로 큐 이관, `routeChange`
      기준 flush) — 완료
- [x] **G3**: `NavIntent`에 `spa`/`push` 분기 추가 — 비-메인탭 목적지는
      네이티브 sub-page push로 열리도록 — 완료
- [x] **G4**: 백그라운드 notifee 탭 유실 수정 (모듈 스코프 pending 큐 +
      메시지 ID 중복 억제) — 완료
- [x] **G5**: Android `default_notification_channel_id` config plugin 추가
      (네이티브 재빌드 필요 — 별도 PR) — 완료
- [x] **G6**: 공유 가이드 문서 정정 (코드 변경 없음, 문서 회람) —
      정정문 작성 완료(`guide-corrections.md`), 회람 대기
- [x] **G7**: 같은 목적지 재탭이 무시되지 않도록 타겟 전달을 값 대신
      시퀀스 객체로 — 완료
- [ ] 4개 타입 × 3가지 앱 상태(포그라운드/백그라운드/종료) × iOS/Android
      수동 QA (`plan.md` "수동 검증" 체크리스트)

## 📆 예상 일정

- 시작일: 2026-07-22 (G1 착수·완료)
- 종료일: TBD — G2~G7은 PR 단위로 순차 진행 (`plan.md` "작업 순서" 참조:
  PR-A 핫픽스 → PR-B(G1+G3+G2) → PR-C(G4+G7) → PR-D(G5, 네이티브 재빌드))

## 🔗 관련 이슈 / 확인 필요

- 서버: #271, PR #272
- `plan.md`의 "웹팀 확인 필요" — 포털 내 공지 뷰어 라우트 존재 여부,
  비-메인탭 목적지 확인, FRIEND 상세 경로 확정 시점
- `plan.md`의 "서버팀 확인/공지 필요" — #271의 "환경별 PORTAL_HOST 정합성"
  규칙이 학교 공지(외부 도메인) 타입에도 그대로 적용되는지, 이 앱의 G1
  가정(공지는 `PORTAL_HOST` 예외)과 상충하지 않는지

## 🔍 참고 자료

- 유니돔 규격서
- RNFirebase Messaging (`getInitialNotification`, `onNotificationOpenedApp`,
  `onMessage`, `setBackgroundMessageHandler`)
- Firebase Cloud Messaging (알림 vs 데이터 메시지)
- `docs/push-notification-routing/plan.md` (이 레포, 상세 설계)
