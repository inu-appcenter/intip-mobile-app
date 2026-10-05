const originalWarn = console.warn;

console.warn = (...args) => {
  const message = args
    .map((argument) => (typeof argument === 'string' ? argument : String(argument)))
    .join(' ');

  if (message.includes("ExpoModulesCoreJSLogger")) {
    return;
  }

  originalWarn(...args);
};

jest.mock('expo-widgets', () => ({
  createLiveActivity: jest.fn(() => ({
    start: jest.fn(),
    getInstances: jest.fn(() => []),
  })),
  createWidget: jest.fn(),
  addPushToStartTokenListener: jest.fn(() => ({ remove: jest.fn() })),
}));

// Local iOS module (modules/intip-live-activity-tokens). Its native half never
// exists under jest, and importing `expo` there breaks some test environments.
jest.mock('./modules/intip-live-activity-tokens', () => ({
  addActivityPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  finishBackgroundWork: jest.fn(),
}));

// Local Android 16 Live Update module (modules/intip-android-live-update).
jest.mock('./modules/intip-android-live-update', () => ({
  IntipAndroidLiveUpdate: {
    isSupported: jest.fn(() => false),
    canPostPromoted: jest.fn(() => false),
    startOrUpdateLiveUpdate: jest.fn(() => ({ success: true, promotable: true })),
    stopLiveUpdate: jest.fn(() => true),
    openPromotionSettings: jest.fn(() => true),
  },
}));

jest.mock('@expo/ui/swift-ui', () => ({
  HStack: 'HStack',
  VStack: 'VStack',
  Text: 'Text',
  Spacer: 'Spacer',
  ProgressView: 'ProgressView',
  Image: 'Image',
  ZStack: 'ZStack',
}));

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
  font: jest.fn(),
  foregroundStyle: jest.fn(),
  monospacedDigit: jest.fn(),
  padding: jest.fn(),
  widgetURL: jest.fn(),
  containerBackground: jest.fn(),
  frame: jest.fn(),
  labelsHidden: jest.fn(),
  lineLimit: jest.fn(),
  multilineTextAlignment: jest.fn(),
  progressViewStyle: jest.fn(),
  tint: jest.fn(),
}));

// The Firebase native module never exists under jest; importing messaging
// throws "Native module RNFBAppModule not found" at module load.
jest.mock('@react-native-firebase/messaging', () => {
  const instance = {
    getToken: jest.fn(() => Promise.resolve('test-fcm-token')),
    onTokenRefresh: jest.fn(() => jest.fn()),
  };
  const messaging = jest.fn(() => instance);
  return { __esModule: true, default: messaging };
});

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

// `agentActionExecutor` reaches the hidden scraper WebView, so any test that
// touches the push/agent graph loads react-native-webview — whose native
// module lookup (`TurboModuleRegistry.getEnforcing`) throws under jest.
jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
