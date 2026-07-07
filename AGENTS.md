# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

# npm usage

On this machine a broken shell snapshot wraps `npm`/`node`/`npx` in a `__work`
function that recurses infinitely (`command not found: __work` →
`maximum nested function level reached`). Before running any npm/node command,
strip the wrappers in the same shell invocation:

```sh
unset -f npm node npx 2>/dev/null
npm run prebuild
```

The real binaries live at `/opt/homebrew/bin` (node v25, npm 11). Shell state
does not persist between commands, so the `unset -f` must be in the same line.
