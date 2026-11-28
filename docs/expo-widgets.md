# expo-widgets / Live Activity 작성 가이드

`src/widgets/*.tsx`의 iOS 위젯·Live Activity를 고치기 전에 읽는다. 여기 적힌 함정은 전부
**타입 체크·테스트·빌드가 다 통과한 채로** 실기기에서만 드러난 것들이다.

기준 버전: `expo-widgets` 57.0.26, `@expo/ui` 57.0.25, iOS 26 (2026-11 실기기 확인).

| 파일 | 종류 |
|---|---|
| `LibraryWatchLiveActivity.tsx` | Live Activity — 도서관 빈자리 알림 |
| `TimetableLiveActivity.tsx` | Live Activity — 수업 (서버 push-to-start도 이 레이아웃으로 그려진다) |
| `NextClassWidget`, `TodayClassesWidget`, `TimetableWidget`, `CafeteriaMenuWidget`, `BusArrivalWidget`(+`BusStopWidget`) | 홈 화면 위젯 (Android는 `expo-widgets-glance`) |

디자인 원본: Figma INTIP › Live Activities › "Live Activity v2 — 횃불이"
(Library Seat Alert LA / Timetable LA / INTIP LA / Dynamic Island 컴포넌트 세트).

---

## 1. 렌더링 구조 — 왜 앱과 다르게 동작하는가

- 레이아웃 함수는 `'widget'` 지시어로 **위젯 확장(ExpoWidgetsTarget) 안의 별도 JS 런타임**에서 실행된다.
  React reconciler가 없다. JSX는 `bundle/jsx-runtime-stub.ts`가 함수 컴포넌트를 즉시 호출해 만든
  **정적 트리(JSON)** 이고, 네이티브 `WidgetsDynamicView`(`expo-widgets/ios/Widgets/DynamicView.swift`)가
  노드 타입별로 SwiftUI 뷰를 만든다.
- 그래서 앱(`@expo/ui`를 RN 화면에서 쓸 때)에서 되는 것이 위젯에서는 조용히 안 될 수 있다.
  **지원 노드는 `DynamicView.swift`의 `case "…View"` 목록이 전부다** (Text, H/V/ZStack, Rectangle,
  RoundedRectangle, Capsule, Circle, Ellipse, Image, ProgressView, Spacer, Divider, Gauge, Chart,
  Label, Button, Link 등). 목록에 없는 컴포넌트는 아무것도 그리지 않는다.
- 함수 바깥 스코프(모듈 상수, import한 헬퍼)는 참조할 수 없다. 색·헬퍼는 함수 **안에서** 선언한다.

## 2. 반드시 피할 것 (실기기에서 깨진 사례)

### 2-1. Text 안에 Text를 넣지 않는다 → 아무것도 안 보인다

```tsx
// ❌ 위젯에선 빈 문자열이 그려진다
<Text><Text modifiers={[foregroundStyle(accent)]}>{seat}</Text>{'\n자리가 났어요'}</Text>

// ✅ 줄/색마다 별도 Text
<VStack alignment="leading" spacing={0}>
  <Text modifiers={[foregroundStyle(accent)]}>{seat}</Text>
  <Text modifiers={[foregroundStyle(ink)]}>자리가 났어요</Text>
</VStack>
```

`@expo/ui`의 `Text`는 자식이 **문자열뿐이면** 하나로 합쳐 `text` prop으로 보내지만, Text 자식이 섞이면
자식 노드로 보낸다. 앱의 `TextView.buildText`는 자식 TextView를 `+`로 이어 붙이지만, 위젯 렌더러의 자식은
TextView 인스턴스가 아니라서 버려지고 **빈 부모 텍스트만 남는다.** 한 줄 안에서 색을 바꿔야 하면
`HStack(alignment="firstTextBaseline", spacing=0)`로 Text를 나란히 둔다(타이머 + "뒤 시작" 참고).
`{a}{' · '}{b}`처럼 문자열 조각만 여러 개인 것은 괜찮다.

### 2-2. 잠금화면 배경에 `activityBackgroundTint`를 쓰지 않는다

iOS 26 잠금화면은 `activityBackgroundTint(color)`를 **유리 틴트**로 쓴다. 연한 색이 진하게 바뀐다
(`#EFF6FF` → 진한 파랑, `#F0FDF4` → 형광 초록). 대신 배경을 직접 칠한다.

### 2-3. `background()`는 내용 폭만큼만 칠한다 → 카드 전체로 펼친다

```tsx
banner: (
  <ZStack alignment="bottomTrailing" modifiers={[background(lockBg)]}>
    <VStack modifiers={[padding({ ... }), frame({ maxWidth: 9999, alignment: 'leading' })]}>…</VStack>
    {character}
  </ZStack>
)
```

`frame({ maxWidth: 9999 })`가 없으면 배경이 가운데에 내용 폭만큼만 깔리고 양옆으로 시스템 배경이
보인다. (`Infinity`는 JSON으로 넘어가지 않으므로 큰 수를 쓴다.)

### 2-4. 홈 화면 위젯 배경은 `containerBackground(color, 'widget')`

Live Activity와 달리 홈 위젯은 `containerBackground`가 맞다(iOS 17+ 필수). 섞어 쓰지 않는다.

## 3. 알고 쓰는 제약

| 항목 | 내용 | 대응 |
|---|---|---|
| 진행바 바탕색 | `ProgressView` 선형 스타일은 tint(채움)만 바꿀 수 있고 트랙 색은 시스템 회색 | `ZStack(alignment="leading")`에 `Capsule`(팔레트 색) + `ProgressView`를 `scaleEffect({x:1,y:2})`로 8pt. 바탕이 살짝 회색빛으로 섞인다 |
| 원형 타이머 ProgressView | `labelsHidden()`을 줘도 안쪽에 경과 시간 라벨이 남는다 | `foregroundStyle('clear')` (링은 tint, 라벨은 foregroundStyle을 따른다) |
| 타이머 Text 폭 | `Text(timerInterval)`은 내용과 무관하게 넓게 잡힌다 | `frame({ width })` 고정. 대략 `size × 2.9`(m:ss), `size × 4.1`(h:mm:ss) |
| 로케일 | 위젯 확장의 로케일은 `en`. `toLocaleTimeString`은 "09:00 AM", `dateStyle: 'relative'`는 영어 | 시간은 직접 포맷. "N시간 M분 남음"은 렌더 시점 `Date.now()`로 계산 |
| 갱신 시점 | 위젯은 props가 바뀔 때만 다시 그려진다 | 계속 움직여야 하는 것(카운트다운·진행바)은 `timerInterval`. `Date.now()`로 만든 문구는 앱이 업데이트할 때까지 멈춰 있다(도서관 알림은 30초 조회마다 `lastCheckedAt`이 바뀌어 다시 그려진다) |
| 글꼴 | 위젯 확장에 Pretendard가 없다 | 시스템 글꼴. 크기·굵기만 디자인 위계를 따른다. Figma(Pretendard)보다 한글 폭이 넓으니 긴 줄엔 `lineLimit(1)` + `minimumScaleFactor(0.8)` |
| 색 | `#RRGGBB`, `#RRGGBBAA`(끝 두 자리가 알파) 지원 | 값은 INTIP 팔레트(Figma 변수)에서 가져오고 옆에 토큰 이름을 주석으로 남긴다 |
| Live Activity 시작 | 앱이 포그라운드일 때만 `start()` 가능 | 등록 화면에서 시작. 시간표는 서버 push-to-start(`src/timetable/liveActivityPushToStart.ts`) |
| 개발 빌드 재설치 | `devicectl install`로 덮어쓰면 떠 있던 Activity가 내려간다(관찰) | 확인할 때마다 알림을 새로 켠다 |

## 4. 이미지

- 위젯 확장의 `Bundle.main`은 앱이 아니라 확장이다. 앱 Assets에 넣은 이미지는 위젯에서 안 보인다.
- `/ios`는 prebuild 산출물(gitignore)이라 직접 넣지 않는다. **`plugins/withWidgetAssets.js`에 등록**한다.
  - 단색 아이콘(색을 바꿔 칠함): `WIDGET_ASSETS` — `assets/widgets/*.svg`, iOS template + Android vector drawable.
  - 컬러 일러스트(횃불이 등): `RASTER_WIDGET_ASSETS` — `assets/widgets/torch/<Name>@2x.png`, `@3x.png`, iOS 전용.
    @1x 기준 높이(지금은 104pt)의 2·3배로 내보낸다.
- 쓰는 법: `<Image assetName="TorchFound" modifiers={[resizable(), aspectRatio({ contentMode: 'fit' }), frame({ width, height })]} />`
  — `resizable()`이 없으면 원본 픽셀 크기로 그려진다.
- 반영하려면 `npx expo prebuild`(또는 `--clean`) 후 네이티브 재빌드. OTA로는 안 나간다.
  확인: `xcrun assetutil --info …/ExpoWidgetsTarget.appex/Assets.car | grep Name`.
- SF Symbol은 `systemName`. Figma에 SF 글리프 문자(예: U+100454 `chair.fill`, U+100AD3 `graduationcap.fill`)로
  들어간 아이콘은 이름으로 옮긴다.

## 5. 크기·영역 (iOS Design Kit, Figma "iOS Design Kit" 섹션)

- 잠금화면 배너: 높이 **최대 160pt**. 지금 레이아웃은 106~136pt.
- Dynamic Island 확장형: 폭 374pt, 여백 18pt, 최대 174pt. 이 앱은 `expandedBottom`만 쓰고 나머지 영역은 비운다
  (지정하지 않은 영역은 `EmptyView`).
- compact: 왼쪽 심볼(28pt, 여백 4.67pt) / 가운데 카메라 영역 95pt / 오른쪽 라벨(끝 여백 8pt, 14 SemiBold).
- minimal: 지름 37pt 안에 링 + 아이콘.

## 6. props는 계약이다

- `TimetableLiveActivityProps`는 **서버(inu-portal-server)가 push-to-start로 그대로 보낸다.** 필드 이름·타입을 바꾸면
  앱이 꺼져 있을 때 뜨는 수업 Activity가 깨진다. 추가만 하고, 새 필드는 optional로 두고 레이아웃에 기본값을 둔다.
- `LibraryWatchLiveActivityProps`는 앱만 만든다(`libraryOngoingService.watchLiveProps` / `watchLabels`). 그래도 앱 업데이트
  직후 떠 있던 Activity는 예전 props로 다시 그려질 수 있으니 새 필드는 optional + 대체 표기(`primary ?? targetName`).

## 7. 확인 절차 (화면은 실기기에서만 검증된다)

1. `npx tsc --noEmit`, `npx jest` — 문법·props·라벨 로직까지만 잡는다. **레이아웃 버그는 못 잡는다.**
2. 기기에 설치: `xcodebuild … -destination id=<UDID>` → `xcrun devicectl device install app --device <UDID> …/INTIP.app`.
3. 앱에서 알림을 새로 켜고(재설치하면 기존 Activity가 내려간다) 잠금화면·Dynamic Island를 본다.
   `iph screenshot -o lock.png`로 잠금화면을 찍을 수 있다(`iph button lock` 후 암호 화면이 뜨면 `iph tap "취소"`).
4. 상태를 다 본다: 찾는 중(좌석·열람실·스터디룸) / 빈자리 발생 / 찾기 종료 / 곧 수업 / 수업 중,
   그리고 밝은·어두운(수면 집중 모드 포함) 잠금화면.
5. Figma 컴포넌트와 나란히 놓고 비교한다.
