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
}));

jest.mock('@expo/ui/swift-ui', () => ({
  HStack: 'HStack',
  VStack: 'VStack',
  Text: 'Text',
  Spacer: 'Spacer',
  ProgressView: 'ProgressView',
  Image: 'Image',
}));

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
  font: jest.fn(),
  foregroundStyle: jest.fn(),
  monospacedDigit: jest.fn(),
  padding: jest.fn(),
  widgetURL: jest.fn(),
  containerBackground: jest.fn(),
}));
