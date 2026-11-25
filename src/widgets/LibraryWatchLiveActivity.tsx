import { HStack, Image, ProgressView, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  font,
  foregroundStyle,
  frame,
  labelsHidden,
  lineLimit,
  monospacedDigit,
  multilineTextAlignment,
  padding,
  progressViewStyle,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityComponent } from 'expo-widgets';

export type LibraryWatchLiveActivityProps = {
  /** WATCHING: 감시 중 · FOUND: 빈자리 발생 · ENDED: 만료/중단 */
  phase: 'WATCHING' | 'FOUND' | 'ENDED';
  kind: 'SEAT' | 'ROOM' | 'STUDY_ROOM';
  targetName: string;
  /** 함께 돌고 있는 다른 감시 수 ("외 N건") */
  extraCount: number;
  startedAt: number;
  expiresAt: number;
  checkCount: number;
  /** 마지막 조회 시각(ms) */
  lastCheckedAt?: number;
  /** FOUND/ENDED 상태 문구 */
  message?: string;
};

/**
 * 도서관 빈자리·스터디룸 취소표 "기다림" Live Activity (잠금화면 + Dynamic Island).
 * iOS에서 Android 상주 알림(LibraryOngoingService.renderWatchActivity)을 대신한다.
 *
 * - 남은 감시 시간은 Text/ProgressView(timerInterval:)로 시스템이 갱신 → 앱은 조회할 때만 업데이트.
 * - 'widget' 지시어: 위젯 확장 런타임에서 따로 실행되므로 바깥 스코프 상수/헬퍼 참조 금지.
 */
const LibraryWatchLiveActivityLayout: LiveActivityComponent<LibraryWatchLiveActivityProps> = (
  props: LibraryWatchLiveActivityProps,
) => {
  'widget';

  const islandPrimary = '#FFFFFF';
  const islandSecondary = '#A1A1A6';
  const lockPrimary = { type: 'hierarchical', style: 'primary' } as const;
  const lockSecondary = { type: 'hierarchical', style: 'secondary' } as const;

  const isFound = props.phase === 'FOUND';
  const isEnded = props.phase === 'ENDED';
  // 감시 중: INU 블루 / 발견: 초록 / 종료: 회색
  const accent = isFound ? '#34C759' : isEnded ? '#8E8E93' : '#5B9BFF';
  const lockAccent = isFound ? '#28A745' : isEnded ? '#8E8E93' : '#3D7EF5';

  const symbol = isFound
    ? 'checkmark.circle.fill'
    : props.kind === 'STUDY_ROOM'
      ? 'person.2.fill'
      : 'chair.fill';

  const kindLabel = props.kind === 'STUDY_ROOM' ? '취소표' : '빈자리';
  const statusText = isFound
    ? `${kindLabel} 발생!`
    : isEnded
      ? '감시 종료'
      : `${kindLabel} 감시 중`;
  const title = props.extraCount > 0 ? `${props.targetName} 외 ${props.extraCount}건` : props.targetName;

  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const last = props.lastCheckedAt ? new Date(props.lastCheckedAt) : null;
  const lastText = last ? `${pad(last.getHours())}:${pad(last.getMinutes())}:${pad(last.getSeconds())}` : '';
  const detailText = props.message
    ? props.message
    : last
      ? `${props.checkCount}회 확인 · 마지막 ${lastText}`
      : '자리가 나면 바로 알려드려요';

  const watchInterval = { lower: new Date(props.startedAt), upper: new Date(props.expiresAt) };
  const isLongTimer = props.expiresAt - props.startedAt >= 60 * 60 * 1000;

  // 남은 감시 시간 카운트다운 (감시 중에만)
  const countdown = (size: number, color: string, alignment: 'leading' | 'trailing') => (
    <Text
      timerInterval={watchInterval}
      modifiers={[
        font({ size, weight: 'semibold' }),
        monospacedDigit(),
        foregroundStyle(color),
        multilineTextAlignment(alignment),
        frame({ width: Math.ceil(size * (isLongTimer ? 4.1 : 2.9)), alignment }),
      ]}
    />
  );
  const trailingInfo = (size: number, color: string, alignment: 'leading' | 'trailing') =>
    isFound || isEnded ? (
      <Text modifiers={[font({ size, weight: 'semibold' }), foregroundStyle(color)]}>
        {isFound ? '지금 배정' : '종료'}
      </Text>
    ) : (
      countdown(size, color, alignment)
    );

  const progressBar = (color: string) => (
    <ProgressView
      timerInterval={watchInterval}
      countsDown={true}
      modifiers={[progressViewStyle('linear'), tint(color), labelsHidden()]}
    />
  );

  return {
    banner: (
      <VStack alignment="leading" spacing={8} modifiers={[padding({ all: 14 })]}>
        <HStack alignment="center" spacing={6}>
          <Image systemName={symbol} size={15} color={lockAccent} />
          <Text modifiers={[font({ size: 15, weight: 'semibold' }), foregroundStyle(lockAccent)]}>
            {statusText}
          </Text>
          <Spacer />
          {trailingInfo(20, lockAccent, 'trailing')}
        </HStack>
        <Text modifiers={[font({ size: 20, weight: 'bold' }), foregroundStyle(lockPrimary), lineLimit(1)]}>
          {title}
        </Text>
        <Text modifiers={[font({ size: 14, weight: 'medium' }), foregroundStyle(lockSecondary), lineLimit(1)]}>
          {detailText}
        </Text>
        {!isFound && !isEnded && progressBar(lockAccent)}
      </VStack>
    ),

    bannerSmall: (
      <HStack alignment="center" spacing={8} modifiers={[padding({ all: 10 })]}>
        <Image systemName={symbol} size={20} color={accent} />
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ size: 15, weight: 'semibold' }), foregroundStyle(islandPrimary), lineLimit(1)]}>
            {title}
          </Text>
          <Text modifiers={[font({ size: 13, weight: 'medium' }), foregroundStyle(accent)]}>{statusText}</Text>
        </VStack>
        <Spacer />
      </HStack>
    ),

    compactLeading: <Image systemName={symbol} size={15} color={accent} />,
    compactTrailing: isFound ? (
      <Text modifiers={[font({ size: 14, weight: 'semibold' }), foregroundStyle(accent)]}>빈자리!</Text>
    ) : (
      trailingInfo(14, accent, 'trailing')
    ),

    minimal: <Image systemName={symbol} size={13} color={accent} />,

    expandedLeading: (
      <HStack alignment="center" spacing={6} modifiers={[padding({ leading: 4 })]}>
        <Image systemName={symbol} size={17} color={accent} />
        <Text modifiers={[font({ size: 15, weight: 'semibold' }), foregroundStyle(accent)]}>{statusText}</Text>
      </HStack>
    ),

    expandedTrailing: (
      <HStack alignment="center" modifiers={[padding({ trailing: 4 })]}>
        {trailingInfo(18, accent, 'trailing')}
      </HStack>
    ),

    expandedBottom: (
      <VStack alignment="leading" spacing={6} modifiers={[padding({ leading: 4, trailing: 4, top: 2 })]}>
        <Text modifiers={[font({ size: 18, weight: 'bold' }), foregroundStyle(islandPrimary), lineLimit(1)]}>
          {title}
        </Text>
        <Text modifiers={[font({ size: 14, weight: 'medium' }), foregroundStyle(islandSecondary), lineLimit(1)]}>
          {detailText}
        </Text>
        {!isFound && !isEnded && progressBar(accent)}
      </VStack>
    ),
  };
};

export const LibraryWatchLiveActivity = createLiveActivity(
  'LibraryWatchLiveActivity',
  LibraryWatchLiveActivityLayout,
);
