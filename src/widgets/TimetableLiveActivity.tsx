import { HStack, Image, ProgressView, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  font,
  foregroundStyle,
  frame,
  lineLimit,
  monospacedDigit,
  multilineTextAlignment,
  padding,
  labelsHidden,
  progressViewStyle,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import {
  createLiveActivity,
  type LiveActivityComponent,
} from 'expo-widgets';

export type TimetableLiveActivityProps = {
  phase: 'UPCOMING' | 'ONGOING';
  courseTitle: string;
  location?: string;
  professor?: string;
  startTimestamp: number;
  endTimestamp: number;
  /** UPCOMING 카운트다운/링의 시작점 (수업 시작 - 알림 리드타임) */
  countdownFromTimestamp?: number;
  durationMinutes?: number;
};

/**
 * iOS Dynamic Island 및 잠금화면 Live Activity (ActivityKit)
 *
 * Apple HIG(Live Activities) 기준으로 구성:
 * - compact: 좌측 로고 마크(컨테이너 없음) + 우측 실시간 카운트다운 — 하나의 정보로 읽히도록
 *   같은 브랜드 색을 쓰고, 카메라 쪽 패딩 없이 좁게 붙인다.
 * - minimal: 정적 로고 대신 진행 링으로 갱신되는 정보를 보여준다.
 * - expanded: compact의 배치(좌 로고·상태 / 우 카운트다운)를 그대로 확대한다.
 * - Lock Screen: expanded와 같은 구조, 표준 여백 14pt, 알림 레이아웃 흉내 금지.
 * - 텍스트는 medium 이상 굵기, 작은 텍스트는 최소화.
 * - 남은 시간은 Text/ProgressView(timerInterval:)로 시스템이 갱신하므로
 *   앱이 매초/매분 업데이트할 필요가 없다.
 *
 * 'widget' 지시어로 인해 이 함수는 위젯 확장 런타임에서 따로 실행된다 —
 * 바깥 스코프의 상수/헬퍼를 참조하면 안 된다.
 */
const TimetableLiveActivityLayout: LiveActivityComponent<TimetableLiveActivityProps> = (
  props: TimetableLiveActivityProps,
) => {
  'widget';

  // Dynamic Island는 모드와 무관하게 항상 검은 불투명 배경이다.
  const islandPrimary = '#FFFFFF';
  const islandSecondary = '#A1A1A6';
  const islandAccent = '#5B9BFF'; // INU Blue를 검은 배경 대비에 맞게 밝힌 값

  // 잠금화면은 시스템 기본 배경을 그대로 쓴다. 이 배경은 environment.colorScheme과
  // 항상 일치하지 않으므로(라이트 모드에서도 어두운 배경으로 렌더링됨) 본문은 배경에
  // 맞춰 적응하는 계층형 스타일을 쓰고, 브랜드 색은 밝은/어두운 배경 모두에서 대비가
  // 나오는 중간 톤을 쓴다.
  const lockPrimary = { type: 'hierarchical', style: 'primary' } as const;
  const lockSecondary = { type: 'hierarchical', style: 'secondary' } as const;
  const lockAccent = '#3D7EF5';

  const symbol = 'graduationcap.fill';
  const isUpcoming = props.phase === 'UPCOMING';
  const startDate = new Date(props.startTimestamp);
  const endDate = new Date(props.endTimestamp);
  const targetDate = isUpcoming ? startDate : endDate;

  // toLocaleTimeString은 위젯 확장의 로케일(en)을 따라 "09:00 AM"이 되므로 직접 포맷한다.
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const targetTimeText = `${pad(targetDate.getHours())}:${pad(targetDate.getMinutes())}`;
  const timeCaption = isUpcoming ? `${targetTimeText} 시작` : `${targetTimeText} 종료`;

  // 카운트다운 구간. Text(timerInterval:)은 upper - max(now, lower)를 보여준다.
  const countdownLower = isUpcoming
    ? new Date(props.countdownFromTimestamp ?? props.startTimestamp - 15 * 60 * 1000)
    : startDate;
  const countdownInterval = { lower: countdownLower, upper: targetDate };
  // 타이머 Text는 내용과 무관하게 넓게 잡히므로 폭을 고정해야 한다. 1시간 이상이면 h:mm:ss.
  const isLongTimer = targetDate.getTime() - countdownLower.getTime() >= 60 * 60 * 1000;

  const statusText = isUpcoming ? '곧 수업' : '수업 중';
  const detailText = [props.location, props.professor].filter(Boolean).join(' · ');

  const countdown = (size: number, color: string, alignment: 'leading' | 'trailing') => (
    <Text
      timerInterval={countdownInterval}
      modifiers={[
        font({ size, weight: 'semibold' }),
        monospacedDigit(),
        foregroundStyle(color),
        multilineTextAlignment(alignment),
        frame({
          width: Math.ceil(size * (isLongTimer ? 4.1 : 2.9)),
          alignment,
        }),
      ]}
    />
  );

  const progressBar = (color: string) => (
    <ProgressView
      timerInterval={{ lower: startDate, upper: endDate }}
      countsDown={false}
      modifiers={[progressViewStyle('linear'), tint(color), labelsHidden()]}
    />
  );

  // 진행 링: 수업 중엔 경과만큼 차오르고, 수업 전엔 남은 시간만큼 줄어든다.
  const progressRing = (size: number) => (
    <ProgressView
      timerInterval={countdownInterval}
      countsDown={isUpcoming}
      modifiers={[
        progressViewStyle('circular'),
        tint(islandAccent),
        // 원형 타이머 ProgressView는 labelsHidden으로도 안쪽 경과 시간 라벨이 남는다.
        // 링은 tint, 라벨은 foregroundStyle을 따르므로 라벨만 투명하게 만든다.
        foregroundStyle('clear'),
        frame({ width: size, height: size }),
      ]}
    />
  );

  return {
    // 잠금화면 / 알림 센터 / StandBy (expanded와 같은 구조)
    banner: (
      <VStack alignment="leading" spacing={8} modifiers={[padding({ all: 14 })]}>
        <HStack alignment="center" spacing={6}>
          <Image systemName={symbol} size={15} color={lockAccent} />
          <Text modifiers={[font({ size: 15, weight: 'semibold' }), foregroundStyle(lockAccent)]}>
            {statusText}
          </Text>
          <Spacer />
          {countdown(22, lockAccent, 'trailing')}
        </HStack>
        <HStack alignment="firstTextBaseline" spacing={8}>
          <Text
            modifiers={[
              font({ size: 20, weight: 'bold' }),
              foregroundStyle(lockPrimary),
              lineLimit(1),
            ]}
          >
            {props.courseTitle}
          </Text>
          <Spacer />
          <Text
            modifiers={[
              font({ size: 15, weight: 'medium' }),
              monospacedDigit(),
              foregroundStyle(lockSecondary),
            ]}
          >
            {timeCaption}
          </Text>
        </HStack>
        {detailText ? (
          <Text
            modifiers={[
              font({ size: 15, weight: 'medium' }),
              foregroundStyle(lockSecondary),
              lineLimit(1),
            ]}
          >
            {detailText}
          </Text>
        ) : null}
        {!isUpcoming && progressBar(lockAccent)}
      </VStack>
    ),

    // Apple Watch Smart Stack / CarPlay (iOS 18+)
    bannerSmall: (
      <HStack alignment="center" spacing={8} modifiers={[padding({ all: 10 })]}>
        <Image systemName={symbol} size={20} color={islandAccent} />
        <VStack alignment="leading" spacing={2}>
          <Text
            modifiers={[
              font({ size: 15, weight: 'semibold' }),
              foregroundStyle(islandPrimary),
              lineLimit(1),
            ]}
          >
            {props.courseTitle}
          </Text>
          {countdown(15, islandAccent, 'leading')}
        </VStack>
        <Spacer />
      </HStack>
    ),

    // Dynamic Island compact — 좌: 로고 마크, 우: 수업 전엔 mm:ss 카운트다운(리드타임
    // 이내라 짧다), 수업 중엔 h:mm:ss가 너무 넓어 좌우 균형이 깨지므로 진행 링.
    // 둘이 하나의 정보로 읽히도록 같은 브랜드 색을 쓴다.
    compactLeading: <Image systemName={symbol} size={15} color={islandAccent} />,
    compactTrailing: isLongTimer ? progressRing(20) : countdown(14, islandAccent, 'trailing'),

    // Dynamic Island minimal — 정적 로고 대신 진행 링 + 로고 마크
    minimal: (
      <ZStack>
        {progressRing(24)}
        <Image systemName={symbol} size={10} color={islandAccent} />
      </ZStack>
    ),

    // Dynamic Island expanded — compact 배치를 확대 (좌 로고·상태 / 우 카운트다운)
    expandedLeading: (
      <HStack alignment="center" spacing={6} modifiers={[padding({ leading: 4 })]}>
        <Image systemName={symbol} size={17} color={islandAccent} />
        <Text modifiers={[font({ size: 15, weight: 'semibold' }), foregroundStyle(islandAccent)]}>
          {statusText}
        </Text>
      </HStack>
    ),

    expandedTrailing: (
      <HStack alignment="center" modifiers={[padding({ trailing: 4 })]}>
        {countdown(20, islandAccent, 'trailing')}
      </HStack>
    ),

    expandedBottom: (
      <VStack
        alignment="leading"
        spacing={6}
        modifiers={[padding({ leading: 4, trailing: 4, top: 2 })]}
      >
        <HStack alignment="firstTextBaseline" spacing={8}>
          <Text
            modifiers={[
              font({ size: 18, weight: 'bold' }),
              foregroundStyle(islandPrimary),
              lineLimit(1),
            ]}
          >
            {props.courseTitle}
          </Text>
          <Spacer />
          <Text
            modifiers={[
              font({ size: 15, weight: 'medium' }),
              monospacedDigit(),
              foregroundStyle(islandSecondary),
            ]}
          >
            {timeCaption}
          </Text>
        </HStack>
        {detailText ? (
          <Text
            modifiers={[
              font({ size: 15, weight: 'medium' }),
              foregroundStyle(islandSecondary),
              lineLimit(1),
            ]}
          >
            {detailText}
          </Text>
        ) : null}
        {!isUpcoming && progressBar(islandAccent)}
      </VStack>
    ),
  };
};

export const TimetableLiveActivity = createLiveActivity(
  'TimetableLiveActivity',
  TimetableLiveActivityLayout,
);
