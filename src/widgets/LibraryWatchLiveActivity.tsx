import { Capsule, HStack, Image, ProgressView, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  background,
  aspectRatio,
  clipShape,
  font,
  foregroundStyle,
  frame,
  labelsHidden,
  lineLimit,
  minimumScaleFactor,
  padding,
  progressViewStyle,
  resizable,
  scaleEffect,
  tint,
  truncationMode,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityComponent } from 'expo-widgets';

export type LibraryWatchLiveActivityProps = {
  /** WATCHING: 찾는 중 · FOUND: 빈자리 발생 · ENDED: 찾기 종료 */
  phase: 'WATCHING' | 'FOUND' | 'ENDED';
  kind: 'SEAT' | 'ROOM' | 'STUDY_ROOM';
  /** 작업 제목(예: "ICT라운지 (이룸관B1F) BFB-003번"). primary가 없을 때의 대체 표기. */
  targetName: string;
  /** 헤드라인 1줄(상태 색): "BFB-003번" · "ICT라운지 빈자리" · "이용 가능한 스터디룸" */
  primary?: string;
  /** 보조 줄 앞부분: 열람실 위치("이룸관B1F") · 스터디룸 이름("그룹스터디실 3") */
  place?: string;
  /** 함께 돌고 있는 다른 알림 수 */
  extraCount: number;
  startedAt: number;
  expiresAt: number;
  checkCount: number;
  /** 마지막 조회 시각(ms). 조회할 때마다 바뀌어 Activity가 다시 그려진다(남은 시간 갱신). */
  lastCheckedAt?: number;
  /** FOUND/ENDED 상세 문구(알림 본문). 화면에는 쓰지 않는다. */
  message?: string;
};

/**
 * 도서관 빈자리·스터디룸 취소표 "빈자리 알림" Live Activity (잠금화면 + Dynamic Island).
 * Figma: INTIP › Live Activities › "Live Activity v2 — 횃불이" (Library Seat Alert LA / Lock Screen,
 * INTIP LA / Dynamic Island). 수치·문구·색은 그 컴포넌트를 그대로 옮긴 것이다.
 *
 * - 헤드라인 2줄(20 Bold): 1줄 대상(상태 색) · 2줄 지금 하는 일. 보조 1줄(14 Medium).
 * - 횃불이가 오른쪽 아래에서 진행바 위에 서 있다. 일러스트는 위젯 확장 asset catalog
 *   (plugins/withWidgetAssets.js의 RASTER_WIDGET_ASSETS).
 * - 색은 INTIP 팔레트(Figma 변수) 값. 주석의 토큰 이름이 원본이다.
 * - "N시간 M분 남음"은 렌더 시점 기준으로 계산한다. 앱이 30초마다 조회하며 lastCheckedAt을 바꿔
 *   다시 그리게 하므로 분 단위 표시로 충분하다. 진행바는 ProgressView(timerInterval:)라 시스템이 움직인다.
 * - 'widget' 지시어: 위젯 확장 런타임에서 따로 실행되므로 바깥 스코프 상수/헬퍼 참조 금지.
 */
const LibraryWatchLiveActivityLayout: LiveActivityComponent<LibraryWatchLiveActivityProps> = (
  props: LibraryWatchLiveActivityProps,
) => {
  'widget';

  const isFound = props.phase === 'FOUND';
  const isEnded = props.phase === 'ENDED';
  const isWatching = !isFound && !isEnded;
  const isStudy = props.kind === 'STUDY_ROOM';

  // 잠금화면
  const lockBg = isFound ? '#F0FDF4' : isEnded ? '#F1F3F5' : '#EFF6FF'; // bg/success · bg/muted · bg/brand
  const lockAccent = isFound ? '#16A34A' : '#0061FF'; // text/success · text/brand
  const lockInk = '#191F28'; // text/primary
  const lockSub = '#6B7684'; // gray/600
  const lockTrackBase = '#DBEAFE'; // blue/100
  const lockTrackFill = '#0061FF'; // text/brand
  // Dynamic Island (항상 검정)
  const islandAccent = isFound ? '#4ADE80' : isEnded ? '#8B95A1' : '#60A5FA'; // green/400 · gray/500 · blue/400
  const islandInk = '#FFFFFF'; // gray/0
  const islandTrackBase = '#BBD9FF';
  const islandTrackFill = '#0061FF'; // interactive/primary
  const neonGreen = '#57FF85'; // branding/appcenter-neongreen

  const art = isFound
    ? 'TorchFound'
    : isEnded
      ? 'TorchEnded'
      : isStudy
        ? 'TorchSearchStudyRoom'
        : props.kind === 'ROOM'
          ? 'TorchSearchRoom'
          : 'TorchSearchSeat';
  // Figma Character 크기(폭 x 높이)
  const artW = isFound ? 80 : isEnded ? 60 : isStudy ? 84 : props.kind === 'ROOM' ? 64 : 72;
  const artH = isWatching && isStudy ? 92 : 104;

  const primary = props.primary || props.targetName;
  const line2Lock = isFound
    ? '자리가 났어요!'
    : isEnded
      ? '이번엔 자리가 안 났어요'
      : props.kind === 'SEAT'
        ? '자리가 비워지길 기다리고 있어요'
        : '찾고 있어요';
  const line2Island = isWatching ? '찾고 있어요' : line2Lock;

  const remainMin = Math.max(0, Math.ceil((props.expiresAt - Date.now()) / 60000));
  const remainText =
    remainMin >= 60
      ? `${Math.floor(remainMin / 60)}시간${remainMin % 60 ? ` ${remainMin % 60}분` : ''} 남음`
      : `${remainMin}분 남음`;
  const place = props.place || '';
  const subText =
    props.kind === 'ROOM'
      ? [place, '지금 잔여 0석'].filter(Boolean).join(' · ')
      : props.kind === 'STUDY_ROOM'
        ? [place, remainText].filter(Boolean).join(' · ')
        : remainText;
  const watchInterval = { lower: new Date(props.startedAt), upper: new Date(props.expiresAt) };

  // 위젯 렌더러는 Text 안의 Text(부분 색)를 그리지 못한다 → 줄마다 별도 Text.
  const headline = (ink: string, accent: string, line2: string) => (
    <VStack alignment="leading" spacing={0}>
      <Text
        modifiers={[font({ size: 20, weight: 'bold' }), foregroundStyle(isEnded ? ink : accent), lineLimit(1), minimumScaleFactor(0.8)]}
      >
        {primary}
      </Text>
      <Text modifiers={[font({ size: 20, weight: 'bold' }), foregroundStyle(ink), lineLimit(1), minimumScaleFactor(0.8)]}>
        {line2}
      </Text>
    </VStack>
  );

  const subline = (color: string) => (
    <Text modifiers={[font({ size: 14, weight: 'medium' }), foregroundStyle(color), lineLimit(1), truncationMode('tail')]}>
      {subText}
    </Text>
  );

  // 8pt 진행바: 팔레트 색 바탕 + 시스템이 채우는 ProgressView(기본 4pt → 2배)
  const track = (base: string, fill: string) => (
    <ZStack alignment="leading" modifiers={[frame({ height: 8 })]}>
      <Capsule modifiers={[foregroundStyle(base), frame({ height: 8 })]} />
      <ProgressView
        timerInterval={watchInterval}
        countsDown={false}
        modifiers={[progressViewStyle('linear'), tint(fill), labelsHidden(), scaleEffect({ x: 1, y: 2 })]}
      />
    </ZStack>
  );

  const character = (bottom: number) => (
    <Image
      assetName={art}
      modifiers={[
        resizable(),
        aspectRatio({ contentMode: 'fit' }),
        frame({ width: artW, height: artH }),
        padding({ trailing: 8, bottom }),
      ]}
    />
  );

  return {
    // 잠금화면: activityBackgroundTint는 iOS 26 잠금화면에서 연한 색을 진한 유리 틴트(형광 초록·진한 파랑)로
    // 바꿔 그리므로 쓰지 않고, 내용을 카드 폭 전체로 펼친 뒤 배경을 직접 칠한다.
    // 패딩 14 + 위 10. 찾는 중엔 보조 줄 + 진행바(캐릭터 발끝이 진행바 위), 발견·종료엔 헤드라인만.
    banner: (
      <ZStack alignment="bottomTrailing" modifiers={[background(lockBg)]}>
        <VStack
          alignment="leading"
          spacing={0}
          modifiers={[
            padding({ top: 24, leading: 14, trailing: 14, bottom: isWatching ? 14 : 26 }),
            frame({ maxWidth: 9999, alignment: 'leading' }),
          ]}
        >
          <VStack alignment="leading" spacing={2} modifiers={[padding({ trailing: artW + 4 })]}>
            {headline(lockInk, lockAccent, line2Lock)}
            {isWatching ? subline(lockSub) : null}
          </VStack>
          {isWatching ? (
            <VStack modifiers={[padding({ top: 12 })]}>{track(lockTrackBase, lockTrackFill)}</VStack>
          ) : null}
        </VStack>
        {character(isWatching ? 18 : 1)}
      </ZStack>
    ),

    bannerSmall: (
      <HStack alignment="center" spacing={8} modifiers={[padding({ all: 10 })]}>
        <Image assetName={art} modifiers={[resizable(), aspectRatio({ contentMode: 'fit' }), frame({ height: 40 })]} />
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ size: 15, weight: 'semibold' }), foregroundStyle(islandInk), lineLimit(1)]}>
            {primary}
          </Text>
          <Text modifiers={[font({ size: 13, weight: 'medium' }), foregroundStyle(islandAccent)]}>{line2Island}</Text>
        </VStack>
        <Spacer />
      </HStack>
    ),

    // compact: 찾는 중엔 앱 심볼 + "찾는중", 발견엔 의자 + "자리 찾음"
    compactLeading: isWatching ? (
      <Image assetName="IntipSymbol" modifiers={[resizable(), frame({ width: 28, height: 28 }), clipShape('circle')]} />
    ) : (
      <Image systemName="chair.fill" size={15} color={isFound ? neonGreen : islandAccent} />
    ),
    compactTrailing: (
      <Text modifiers={[font({ size: 14, weight: 'semibold' }), foregroundStyle(islandAccent)]}>
        {isFound ? '자리 찾음' : isEnded ? '종료' : '찾는중'}
      </Text>
    ),

    // minimal: 남은 시간 링 + 의자
    minimal: (
      <ZStack>
        {isWatching ? (
          <ProgressView
            timerInterval={watchInterval}
            countsDown={true}
            modifiers={[progressViewStyle('circular'), tint(islandAccent), foregroundStyle('clear'), frame({ width: 31, height: 31 })]}
          />
        ) : (
          <ProgressView
            value={1}
            modifiers={[progressViewStyle('circular'), tint(islandAccent), labelsHidden(), frame({ width: 31, height: 31 })]}
          />
        )}
        <Image systemName="chair.fill" size={12} color={isFound ? neonGreen : islandAccent} />
      </ZStack>
    ),

    // 확장형: 헤드라인(찾는 중엔 + 진행바), 오른쪽 아래 횃불이
    expandedBottom: (
      <ZStack alignment="bottomTrailing">
        <VStack alignment="leading" spacing={0} modifiers={[padding({ all: 6 }), frame({ maxWidth: 9999, alignment: 'leading' })]}>
          <VStack alignment="leading" spacing={2} modifiers={[padding({ trailing: artW + 4 })]}>
            {headline(islandInk, islandAccent, line2Island)}
          </VStack>
          {isWatching ? (
            <VStack modifiers={[padding({ top: 12 })]}>{track(islandTrackBase, islandTrackFill)}</VStack>
          ) : null}
        </VStack>
        {character(0)}
      </ZStack>
    ),
  };
};

export const LibraryWatchLiveActivity = createLiveActivity(
  'LibraryWatchLiveActivity',
  LibraryWatchLiveActivityLayout,
);
