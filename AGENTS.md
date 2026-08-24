# Karin App Guide

## Project

Karin is an Android-first React Native app for managing a bundled proot environment and KarinJS/Karin processes on mobile. The current phase is UI prototyping; proot, process control, terminal execution, file access, memory usage, and version switching are placeholders unless explicitly implemented later.

## Stack

- React Native 0.87, React 19, TypeScript
- Android is the primary target; iOS files were intentionally removed
- Entry: `index.js` -> `src/App.tsx`
- Safe areas: `react-native-safe-area-context`
- Icons: `lucide-react-native` + `react-native-svg`
- Node.js >= 22.11

## Current UI

- Bottom navigation: Home, Plugins, Settings
- Home: Karin runtime, memory placeholder, architecture, version row, terminal and file-manager shortcuts
- Top-right container indicator opens restart/force-restart actions
- Bottom-right power button independently starts/stops Karin in UI state
- Version selection uses an iOS-style bottom sheet with a collapsible list
- Light and dark themes follow the system color scheme

Keep these concepts separate:

- **Container state**: proot lifecycle (`starting`, `running`, `stopped`)
- **Karin state**: Karin process lifecycle and runtime timer

## UI Direction

- Design for compact Android phone screens, inspired by operational tools such as KernelSU and LSPosed
- Prefer dense information rows and small status cards; avoid large hero cards and desktop-style KPI panels
- Use Lucide icons instead of emoji or temporary text glyphs
- Import icons from the `lucide-react-native` package root. Metro 0.87 currently fails to resolve imports such as `lucide-react-native/icons/home`
- Keep Settings in bottom navigation; do not add a duplicate header Settings button

## Commands

```sh
npm start
npm run android
npx tsc --noEmit
npm run lint -- --no-cache
npm test -- --runInBand
```

Jest may fail in some local installs because the React Native preset resolves through pnpm-style paths and treats its ESM setup as CommonJS. Type checking and linting are still required for UI changes.

## Change Rules

- Preserve existing Android package-name, launcher-icon, and Android-only changes
- Do not restore deleted iOS files unless explicitly requested
- Keep native/proot integration behind clear service boundaries when it is introduced; do not embed shell/process logic directly into UI components
- Replace placeholder values only when a real native data source is added
- Verify changes with TypeScript and ESLint; run Jest when the local preset is working
