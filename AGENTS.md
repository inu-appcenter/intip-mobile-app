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

# Shared bridge — git submodule (NOT an npm package)

The native↔web message contract (`inu-appcenter/intip-bridge`) is consumed here
as a **git submodule** at `packages/intip-bridge`, compiled **from source** (a
relative import in `src/components/WebViewContainer.tsx`). It is no longer an
npm / GitHub Packages dependency. `inu-portal-web` uses it the same way.

- **Clone**: `git clone --recurse-submodules …`, or after a plain clone run
  `git submodule update --init`. CI must init submodules too.
- `zod` is a **direct dependency** here precisely because the bridge source is
  compiled in-app (bridge `messages.ts` imports it).
- tsc and eslint skip the submodule's own repo files (`tsconfig.json` `exclude`,
  `eslint.config.js` `ignores: ["packages/**"]`); only the source we import is
  type-checked (via import-following).
- **Changing the contract**: edit + commit + push in the bridge repo, then bump
  the pin here — `git submodule update --remote packages/intip-bridge && git add
  packages/intip-bridge` — and do the same in `inu-portal-web`. No npm publish,
  version bump, or `npm update`; the pin is a git SHA, not a semver.
- The bridge source must compile under **both** consumers' strict tsconfig
  (e.g. the web's `noUnusedLocals`).
