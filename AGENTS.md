# Karin App Guide

## Project

Karin is an Android-first React Native app for managing a bundled proot environment and KarinJS/Karin processes on mobile. The current phase is UI prototyping; process control, terminal execution, file access, and memory usage are placeholders unless explicitly implemented later. proot container startup, in-container command execution (via the karin-ipc daemon), environment installation, and Karin version switching are implemented.

## Container Notes

- SELinux blocks hardlinks in the app-private directory on some devices, so proot runs with `--link2symlink` when the hardlink probe fails. pnpm is forced to `package-import-method=copy` at every boot: proot's l2s shadow links corrupt under `pnpm install -f` and leave dangling symlinks that read as ENOENT inside the container.
- `node-karin init` runs only once (markers: `/root/karin/index.mjs` and `.env`); its internal `pnpm install -f` must not be repeated.
- npm 读回的 registry 可能带结尾 `/`（官方源设置时没有、装完再读就多一个 `/`），比较 registry 前必须先 `normalizeRegistry`（`src/screens/SettingsScreen.tsx`），否则官方源会被误判成自定义源。
- Native layout: `ProotModule.kt` (React bridge + daemon session), `RootfsInstaller.kt` (rootfs extraction), `ProotRuntime.kt` (proot argv/env + guest processes), `IpcProtocol.kt` (frame codec), `cpp/karin-ipc.c` (in-container daemon).

## Stack

- React Native 0.87, React 19, TypeScript
- Android is the primary target; iOS files were intentionally removed
- Entry: `index.js` -> `src/App.tsx`
- Safe areas: `react-native-safe-area-context`
- Icons: `lucide-react-native` + `react-native-svg`
- Code highlighting: `lowlight` (highlight.js grammars) via `CodeViewer`; editor is a plain `TextInput` (`CodeEditor`) — no transparent-overlay highlighting, it desyncs on scroll
- Node.js >= 22.11

## Current UI

- Bottom navigation: Home, Plugins, Settings
- Home: Karin runtime, memory placeholder, architecture, terminal and file-manager shortcuts
- Top-right container indicator opens restart/force-restart actions
- Bottom-right power button independently starts/stops Karin in UI state
- Settings shows the real installed node-karin version; its bottom sheet fetches the version list from npm (`npm view node-karin versions`) and switches versions via `pnpm i node-karin@<version>`
- Settings 的「GitHub 加速」只放一个输入框（placeholder 示意 `https://gh-proxy.com/`）加一个保存按钮，留空即直连，值存在 `/root/.karinapp/settings.json`；只对 GitHub 域名生效：git clone/fetch（`pluginService`）、app 插件 curl 下载、README 图片（`MarkdownView`），命令是同步拼的所以启动时/插件页加载时会先 `loadAppSettings()`
- Plugins 顶部筛选：全部 / 已安装 / 未安装 常驻，分类（官方插件、工具、适配器、娱乐 + 市场新标签）收在可展开按钮里，展开后换行平铺全部筛选项，当前分类显示在顶部统计行；市场标签（`category`/`categories`/`tags`）由 `pluginService` 归一，市场新增分类不用改 UI
- app 类型插件是多文件集合：js 文件统一落在 `/root/karin/plugins/karin-plugin-example`，市场条目按插件名正常展示，另外固定有一个 `karin-plugin-example` 目录条目（只能卸载，空目录显示“暂未安装 APP 插件”）
- app 插件（含目录条目）只要涉及 2 个以上文件，安装和卸载都会弹出勾选列表，默认全部不勾选，只处理勾选的文件；只有 1 个文件时才直接执行
- app 插件归属用 sha256 判断：`appPluginFileNames` 只用于下载计划，已安装状态靠 `/root/karin/.karin-app-plugins.json`（安装时记录的 文件名+哈希）与目录里的实际文件哈希匹配，所以改文件名不会被误判、外来同名文件也不会算作该插件；装卸都不按插件名建目录
- app 安装遇到目录里已有同名文件且不属于当前插件时，弹窗让用户选择「替换」或「重命名」，重命名会把新文件写成 `<name>-1.js` 这类不冲突的名字
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
