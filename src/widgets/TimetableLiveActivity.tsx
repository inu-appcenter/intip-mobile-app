import { Capsule, HStack, Image, ProgressView, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  background,
  aspectRatio,
  font,
  foregroundStyle,
  frame,
  labelsHidden,
  lineLimit,
  monospacedDigit,
  multilineTextAlignment,
  padding,
  progressViewStyle,
  resizable,
  scaleEffect,
  tint,
  truncationMode,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityComponent } from 'expo-widgets';

export type TimetableLiveActivityProps = {
  phase: 'UPCOMING' | 'ONGOING';
  courseTitle: string;
  location?: string;
  professor?: string;
  startTimestamp: number;
  endTimestamp: number;
  /** UPCOMING 카운트다운/진행바의 시작점 (수업 시작 - 알림 리드타임) */
  countdownFromTimestamp?: number;
  durationMinutes?: number;
};

/**
 * 수업 Live Activity (잠금화면 + Dynamic Island).
 * Figma: INTIP › Live Activities › "Live Activity v2 — 횃불이" (Timetable LA / Lock Screen,
 * INTIP LA / Dynamic Island). 수치·문구·색은 그 컴포넌트를 그대로 옮긴 것이다.
 *
 * - 곧 수업: 달려가는 횃불이 + "12:03 뒤 시작 / 과목" · 수업 중: 노트 든 횃불이 + "과목 / 42:10 남음".
 *   헤드라인 20 Bold(숫자만 상태 색), 보조 14 Medium. 일러스트는 위젯 확장 asset catalog.
 * - 남은 시간과 진행바는 Text/ProgressView(timerInterval:)로 시스템이 갱신하므로 앱이 업데이트할 필요가 없다.
 * - 서버 push-to-start로 시작된 Activity는 수업이 시작돼도 UPCOMING 그대로다(서버에 업데이트 토큰이 없고
 *   앱은 꺼져 있을 수 있다). 서버는 stale-date를 수업 시작으로 두므로, 그때 시스템이 다시 그리면 현재
 *   시각으로 "수업 중"을 판단한다.
 * - 'widget' 지시어: 위젯 확장 런타임에서 따로 실행되므로 바깥 스코프 상수/헬퍼 참조 금지.
 */
const TimetableLiveActivityLayout: LiveActivityComponent<TimetableLiveActivityProps> = (
  props: TimetableLiveActivityProps,
) => {
  'widget';

  const isUpcoming = props.phase === 'UPCOMING' && Date.now() < props.startTimestamp;
  const startDate = new Date(props.startTimestamp);
  const endDate = new Date(props.endTimestamp);
  const targetDate = isUpcoming ? startDate : endDate;

  // INTIP 팔레트(Figma 변수)
  const lockBg = isUpcoming ? '#FFFAEB' : '#EFF6FF'; // bg/warn · bg/brand
  const lockAccent = isUpcoming ? '#B58000' : '#0061FF'; // text/warn · text/brand
  const lockInk = '#191F28'; // text/primary
  const lockSub = '#6B7684'; // gray/600
  const lockTrackBase = isUpcoming ? '#FEF3C7' : '#DBEAFE'; // yellow/100 · blue/100
  const lockTrackFill = isUpcoming ? '#FBB32F' : '#0061FF'; // brand/yellow · text/brand
  const islandAccent = isUpcoming ? '#FBB32F' : '#60A5FA'; // brand/yellow · blue/400
  const islandInk = '#FFFFFF'; // gray/0
  const islandSub = '#B0B8C1'; // gray/400
  const islandTrackBase = isUpcoming ? '#FEF3C7' : '#BBD9FF'; // yellow/100 · (Figma 지정값)
  const islandTrackFill = isUpcoming ? '#FBB32F' : '#0061FF'; // brand/yellow · interactive/primary

  const art = isUpcoming ? 'TorchClassUpcoming' : 'TorchClassOngoing';
  const artW = isUpcoming ? 77 : 60; // Figma Character 폭(높이 104)

  // toLocaleTimeString은 위젯 확장의 로케일(en)을 따라 "09:00 AM"이 되므로 직접 포맷한다.
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const endText = `${pad(endDate.getHours())}:${pad(endDate.getMinutes())}`;
  const subText = isUpcoming
    ? [props.location, props.professor].filter(Boolean).join(' · ')
    : [props.location, `${endText} 종료`].filter(Boolean).join(' · ');

  // Text(timerInterval:)은 upper - max(now, lower)를 보여준다.
  const countdownLower = isUpcoming
    ? new Date(props.countdownFromTimestamp ?? props.startTimestamp - 15 * 60 * 1000)
    : startDate;
  const countdownInterval = { lower: countdownLower, upper: targetDate };
  // 타이머 Text는 내용과 무관하게 넓게 잡히므로 폭을 고정해야 한다. 지금 남은 시간이 1시간 이상이면 h:mm:ss.
  // (수업 전체 길이로 정하면 75분 수업의 마지막 1시간 내내 "44:48      남음"처럼 벌어진다.)
  const isLongTimer = targetDate.getTime() - Math.max(Date.now(), countdownLower.getTime()) >= 60 * 60 * 1000;

  const timer = (size: number, color: string, weight: 'bold' | 'semibold') => (
    <Text
      timerInterval={countdownInterval}
      modifiers={[
        font({ size, weight }),
        monospacedDigit(),
        foregroundStyle(color),
        multilineTextAlignment('leading'),
        frame({ width: Math.ceil(size * (isLongTimer ? 4.1 : 2.9)), alignment: 'leading' }),
      ]}
    />
  );

  const titleLine = (ink: string) => (
    <Text modifiers={[font({ size: 20, weight: 'bold' }), foregroundStyle(ink), lineLimit(1), truncationMode('tail')]}>
      {props.courseTitle}
    </Text>
  );
  const timerLine = (ink: string, accent: string) => (
    <HStack alignment="firstTextBaseline" spacing={0}>
      {timer(20, accent, 'bold')}
      <Text modifiers={[font({ size: 20, weight: 'bold' }), foregroundStyle(ink)]}>
        {isUpcoming ? ' 뒤 시작' : ' 남음'}
      </Text>
    </HStack>
  );

  // 8pt 진행바: 팔레트 색 바탕 + 시스템이 채우는 ProgressView(기본 4pt → 2배)
  const track = (base: string, fill: string) => (
    <ZStack alignment="leading" modifiers={[frame({ height: 8 })]}>
      <Capsule modifiers={[foregroundStyle(base), frame({ height: 8 })]} />
      <ProgressView
        timerInterval={countdownInterval}
        countsDown={false}
        modifiers={[progressViewStyle('linear'), tint(fill), labelsHidden(), scaleEffect({ x: 1, y: 2 })]}
      />
    </ZStack>
  );

  // 헤드라인 2줄 + 보조 1줄 + 진행바, 오른쪽 아래 횃불이(발끝이 진행바 위)
  const body = (ink: string, sub: string, accent: string, base: string, fill: string, insets: { top: number; side: number; bottom: number }, artBottom: number) => (
    <ZStack alignment="bottomTrailing">
      <VStack
        alignment="leading"
        spacing={0}
        modifiers={[
          padding({ top: insets.top, leading: insets.side, trailing: insets.side, bottom: insets.bottom }),
          frame({ maxWidth: 9999, alignment: 'leading' }),
        ]}
      >
        <VStack alignment="leading" spacing={2} modifiers={[padding({ trailing: artW + 4 })]}>
          {isUpcoming ? timerLine(ink, accent) : titleLine(ink)}
          {isUpcoming ? titleLine(ink) : timerLine(ink, accent)}
          {subText ? (
            <Text
              modifiers={[font({ size: 14, weight: 'medium' }), foregroundStyle(sub), lineLimit(1), truncationMode('tail')]}
            >
              {subText}
            </Text>
          ) : null}
        </VStack>
        <VStack modifiers={[padding({ top: 12 })]}>{track(base, fill)}</VStack>
      </VStack>
      <Image
        assetName={art}
        modifiers={[
          resizable(),
          aspectRatio({ contentMode: 'fit' }),
          frame({ width: artW, height: 104 }),
          padding({ trailing: 8, bottom: artBottom }),
        ]}
      />
    </ZStack>
  );

  const cap = (size: number) => <Image systemName="graduationcap.fill" size={size} color={islandAccent} />;

  return {
    // 잠금화면 / 알림 센터 / StandBy — 패딩 14 + 위 10. activityBackgroundTint는 iOS 26 잠금화면에서
    // 연한 색을 진한 유리 틴트로 바꿔 그리므로 쓰지 않고, 내용을 카드 폭 전체로 펼친 뒤 배경을 직접 칠한다.
    banner: (
      <VStack modifiers={[background(lockBg)]}>
        {body(lockInk, lockSub, lockAccent, lockTrackBase, lockTrackFill, { top: 24, side: 14, bottom: 14 }, 18)}
      </VStack>
    ),

    // Apple Watch Smart Stack / CarPlay (iOS 18+)
    bannerSmall: (
      <HStack alignment="center" spacing={8} modifiers={[padding({ all: 10 })]}>
        <Image assetName={art} modifiers={[resizable(), aspectRatio({ contentMode: 'fit' }), frame({ height: 40 })]} />
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ size: 15, weight: 'semibold' }), foregroundStyle(islandInk), lineLimit(1)]}>
            {props.courseTitle}
          </Text>
          {timer(15, islandAccent, 'semibold')}
        </VStack>
        <Spacer />
      </HStack>
    ),

    // compact: 학사모 + 곧 수업엔 "곧 수업", 수업 중엔 남은 시간
    compactLeading: cap(15),
    compactTrailing: isUpcoming ? (
      <Text modifiers={[font({ size: 14, weight: 'semibold' }), foregroundStyle(islandAccent)]}>곧 수업</Text>
    ) : (
      timer(14, islandAccent, 'semibold')
    ),

    // minimal: 진행 링 + 학사모. 원형 타이머 ProgressView는 labelsHidden으로도 안쪽 라벨이 남아
    // foregroundStyle('clear')로 라벨만 지운다.
    minimal: (
      <ZStack>
        <ProgressView
          timerInterval={countdownInterval}
          countsDown={isUpcoming}
          modifiers={[progressViewStyle('circular'), tint(islandAccent), foregroundStyle('clear'), frame({ width: 31, height: 31 })]}
        />
        {cap(12)}
      </ZStack>
    ),

    // 확장형: 잠금화면과 같은 구조를 검정 배경에
    expandedBottom: body(islandInk, islandSub, islandAccent, islandTrackBase, islandTrackFill, { top: 6, side: 6, bottom: 6 }, 4),
  };
};

export const TimetableLiveActivity = createLiveActivity('TimetableLiveActivity', TimetableLiveActivityLayout);
