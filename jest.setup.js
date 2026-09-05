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
