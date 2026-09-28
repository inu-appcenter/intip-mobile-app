import { HStack, Image, ProgressView, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  font,
  foregroundStyle,
  monospacedDigit,
  padding,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import {
  createLiveActivity,
  type LiveActivityComponent,
  type LiveActivityEnvironment,
} from 'expo-widgets';

export type TimetableLiveActivityProps = {
  phase: 'UPCOMING' | 'ONGOING';
  courseTitle: string;
  location?: string;
  professor?: string;
  startTimestamp: number;
  endTimestamp: number;
  durationMinutes?: number;
};

/**
 * iOS Dynamic Island 및 잠금화면 Live Activity (ActivityKit)
 *
 * 'widget' 지시어로 인해 번들링 시 Swift ActivityConfiguration 코드로 추출됩니다.
 */
const TimetableLiveActivityLayout: LiveActivityComponent<TimetableLiveActivityProps> = (
  props: TimetableLiveActivityProps,
  environment: LiveActivityEnvironment,
) => {
  'widget';

  const isDark = environment.colorScheme === 'dark';
  const primaryText = isDark ? '#FFFFFF' : '#111111';
  const secondaryText = isDark ? '#A0A0A5' : '#6B6B70';
  const accentColor = '#0055D4'; // INU Blue
  const tagBg = isDark ? '#1C2E4A' : '#E8F1FF';

  const isUpcoming = props.phase === 'UPCOMING';
  const targetDate = isUpcoming
    ? new Date(props.startTimestamp || Date.now())
    : new Date(props.endTimestamp || Date.now());

  const badgeText = isUpcoming ? '다음 수업' : '수업 중';
  const subtitleText = props.location || (isUpcoming ? '수업 준비' : '수업 진행 중');

  return {
    // 1. 잠금화면 배너 (Lock Screen & AOD Banner)
    banner: (
      <VStack
        alignment="leading"
        spacing={8}
        modifiers={[
          padding({ all: 16 }),
          widgetURL('intipmobileapp://timetable'),
        ]}
      >
        <HStack alignment="center" spacing={8}>
          <Text
            modifiers={[
              font({ size: 12, weight: 'semibold' }),
              foregroundStyle(accentColor),
              padding({ leading: 6, trailing: 6, top: 2, bottom: 2 }),
            ]}
          >
            {badgeText}
          </Text>
          <Text
            modifiers={[
              font({ size: 16, weight: 'bold' }),
              foregroundStyle(primaryText),
            ]}
          >
            {props.courseTitle}
          </Text>
          <Spacer />
          <Text
            modifiers={[
              font({ size: 14, weight: 'bold' }),
              foregroundStyle(accentColor),
              monospacedDigit(),
            ]}
          >
            {/* 시스템 네이티브 카운트다운 타이머 */}
            {isUpcoming ? '시작까지 ' : '종료까지 '}
            <Text
              modifiers={[
                font({ size: 14, weight: 'bold' }),
                foregroundStyle(accentColor),
                monospacedDigit(),
              ]}
            >
              {targetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </Text>
        </HStack>

        <HStack alignment="center">
          <Text
            modifiers={[
              font({ size: 13, weight: 'regular' }),
              foregroundStyle(secondaryText),
            ]}
          >
            {subtitleText} {props.professor ? `· ${props.professor}` : ''}
          </Text>
          <Spacer />
        </HStack>
      </VStack>
    ),

    // 2. Dynamic Island Compact Leading (알약 좌측)
    compactLeading: (
      <HStack alignment="center" spacing={4} modifiers={[padding({ leading: 4 })]}>
        <Text modifiers={[font({ size: 12, weight: 'bold' }), foregroundStyle(accentColor)]}>
          🎓
        </Text>
        <Text
          modifiers={[
            font({ size: 12, weight: 'semibold' }),
            foregroundStyle(primaryText),
          ]}
        >
          {props.courseTitle.length > 5 ? `${props.courseTitle.slice(0, 5)}…` : props.courseTitle}
        </Text>
      </HStack>
    ),

    // 3. Dynamic Island Compact Trailing (알약 우측)
    compactTrailing: (
      <HStack alignment="center" spacing={2} modifiers={[padding({ trailing: 4 })]}>
        <Text
          modifiers={[
            font({ size: 12, weight: 'bold' }),
            foregroundStyle(accentColor),
            monospacedDigit(),
          ]}
        >
          {targetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </HStack>
    ),

    // 4. Dynamic Island Minimal (타 앱과 공유 시 최소 원형)
    minimal: (
      <Text modifiers={[font({ size: 12, weight: 'bold' }), foregroundStyle(accentColor)]}>
        🎓
      </Text>
    ),

    // 5. Dynamic Island Expanded (길게 탭 시 확장 상세 뷰)
    expandedLeading: (
      <VStack alignment="leading" spacing={2} modifiers={[padding({ leading: 8, top: 4 })]}>
        <Text
          modifiers={[
            font({ size: 11, weight: 'bold' }),
            foregroundStyle(accentColor),
          ]}
        >
          {badgeText}
        </Text>
        <Text
          modifiers={[
            font({ size: 15, weight: 'bold' }),
            foregroundStyle(primaryText),
          ]}
        >
          {props.courseTitle}
        </Text>
      </VStack>
    ),

    expandedTrailing: (
      <VStack alignment="trailing" spacing={2} modifiers={[padding({ trailing: 8, top: 4 })]}>
        <Text
          modifiers={[
            font({ size: 13, weight: 'semibold' }),
            foregroundStyle(secondaryText),
          ]}
        >
          {props.location || '강의실'}
        </Text>
        <Text
          modifiers={[
            font({ size: 13, weight: 'bold' }),
            foregroundStyle(accentColor),
            monospacedDigit(),
          ]}
        >
          {targetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </VStack>
    ),

    expandedBottom: (
      <VStack
        alignment="leading"
        spacing={4}
        modifiers={[
          padding({ leading: 8, trailing: 8, bottom: 6 }),
          widgetURL('intipmobileapp://timetable'),
        ]}
      >
        <HStack alignment="center">
          <Text
            modifiers={[
              font({ size: 12, weight: 'regular' }),
              foregroundStyle(secondaryText),
            ]}
          >
            {props.professor ? `담당: ${props.professor} 교수님` : '실시간 수업 시간표'}
          </Text>
          <Spacer />
          <Text
            modifiers={[
              font({ size: 11, weight: 'medium' }),
              foregroundStyle(accentColor),
            ]}
          >
            시간표 바로가기 →
          </Text>
        </HStack>
      </VStack>
    ),
  };
};

export const TimetableLiveActivity = createLiveActivity(
  'TimetableLiveActivity',
  TimetableLiveActivityLayout,
);
