# Karin App Guide

## Project

Karin is an Android-first React Native app for managing a bundled proot environment and KarinJS/Karin processes on mobile. The app only serves node-karin. The current phase is UI prototyping; generic terminal execution, file access, and memory usage are placeholders unless explicitly implemented later. proot container startup, in-container command execution (via the karin-ipc daemon), environment installation, Karin version switching, and the Karin log console (runtime logs + console input) are implemented.

## Container Notes

- SELinux blocks hardlinks in the app-private directory on some devices, so proot runs with `--link2symlink` when the hardlink probe fails. pnpm is forced to `package-import-method=copy` at every boot: proot's l2s shadow links corrupt under `pnpm install -f` and leave dangling symlinks that read as ENOENT inside the container.
- `node-karin init` runs only once (markers: `/root/karin/index.mjs` and `.env`); its internal `pnpm install -f` must not be repeated.
- rootfs 预装了 Node.js/npm/pnpm 与 curl、ca-certificates、xz-utils，启动时不再检测/安装这些依赖，只在容器内执行一次 `apt-get update`（失败仅记日志，不阻塞启动）。
- npm 读回的 registry 可能带结尾 `/`（官方源设置时没有、装完再读就多一个 `/`），比较 registry 前必须先 `normalizeRegistry`（`src/screens/SettingsScreen.tsx`），否则官方源会被误判成自定义源。
- Native layout: `ProotModule.kt` (React bridge + daemon session), `RootfsInstaller.kt` (rootfs extraction), `ProotRuntime.kt` (proot argv/env + guest processes), `IpcProtocol.kt` (frame codec), `cpp/karin-ipc.c` (in-container daemon).
- 守护进程默认仍给子进程 `/dev/null` 作 stdin；只有带 `EXEC_FLAG_STDIN`（EXEC 帧尾部的 flags 字节）启动的命令才会拿到 stdin 管道，之后用 `REQ_WRITE` 帧写入。Karin 常驻进程以该方式启动，控制台输入才能通过 `process.stdin` 的 data 事件进入 node-karin；写端非阻塞并带 256KB 上限，子进程不读时不会卡住守护进程。

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
- Home: Karin runtime, memory placeholder, architecture, runtime-log and file-manager shortcuts
- 运行日志页（Home 的「运行日志」进入，`TerminalScreen`）：只展示 Karin 常驻进程的 stdout/stderr，不做通用终端。日志由 `karinLogService` 在 App 挂载时开始捕获（环形缓冲 2000 行、~120ms 合并通知、把 ANSI 颜色解析成样式段），所以进页面之前的历史也在；列表贴底自动跟随（偏移量用原生内容高度减可视高度算，不用 FlatList 的 `scrollToEnd`：它按已量出的行高估算末尾位置，长日志在行内换行撑高后估算值偏小、只能停在那一行的第一行，跟随状态只由用户拖拽/惯性结束事件改，程序化贴底触发的 `onScroll` 不算），上滑查看历史时暂停，日志颜色由 `src/utils/ansi.ts` 解析（SGR → 样式段：16 色 + bold/dim/underline，`38;5;n` 只映射前 16 色、真彩色忽略，其余光标/清屏/OSC 序列丢弃），取色在渲染时按明暗主题各用一套调色板，所以切换主题不需要重新解析；日志行用嵌套 `Text` 上色 + `Text selectable`，长按走 Android 原生文本选择（可只选一段、系统菜单里复制，复制出来的是不含转义序列的纯文本），标题栏只保留清空；底部输入框回车把一行文本写进 node-karin 的 stdin（本地回显 `$ 命令`），Karin 未运行时输入禁用
- Top-right container indicator opens restart/force-restart actions
- Bottom-right power button independently starts/stops Karin in UI state
- Settings shows the real installed node-karin version; its bottom sheet fetches the version list from npm (`npm view node-karin versions`) and switches versions via `pnpm i node-karin@<version>`
- Settings 的「GitHub 加速」只放一个输入框（placeholder 示意 `https://gh-proxy.com/`）加一个保存按钮，留空即直连，值存在 `/root/.karinapp/settings.json`；只对 GitHub 域名生效：git clone/fetch（`pluginService`）、app 插件 curl 下载、README 图片（`MarkdownView`），命令是同步拼的所以启动时/插件页加载时会先 `loadAppSettings()`
- Plugins 顶部筛选：全部 / 已安装 / 未安装 常驻，分类（官方插件、工具、适配器、娱乐 + 市场新标签）收在可展开按钮里，展开后换行平铺全部筛选项，当前分类显示在顶部统计行；市场标签（`category`/`categories`/`tags`）由 `pluginService` 归一，市场新增分类不用改 UI
- Plugins 顶部统计行下面是搜索框（`PluginsScreen` 的 `query`）：匹配插件名或市场里的介绍（不区分大小写），和分类/安装状态筛选叠加生效，搜索时统计行改成 `搜索「x」· N 个结果`，右侧 `X` 清空，无结果时提示 `没有匹配「x」的插件`
- app 类型插件是多文件集合：js 文件统一落在 `/root/karin/plugins/karin-plugin-example`，市场条目按插件名正常展示，另外固定有一个 `karin-plugin-example` 目录条目（只能卸载，空目录显示“暂未安装 APP 插件”）
- app 插件（含目录条目）只要涉及 2 个以上文件，安装和卸载都会弹出勾选列表，默认全部不勾选，只处理勾选的文件；只有 1 个文件时才直接执行
- app 插件归属用 sha256 判断：`appPluginFiles` / `appInstallPlan` 只用于下载计划，已安装状态靠 `/root/karin/.karin-app-plugins.json`（安装时记录的 文件名+哈希）与目录里的实际文件哈希匹配，所以改文件名不会被误判、外来同名文件也不会算作该插件；装卸都不按插件名建目录
- app 安装遇到目录里已有同名文件且不属于当前插件时，弹窗让用户选择「替换」或「重命名」，重命名会把新文件写成 `<name>-1.js` 这类不冲突的名字
- 启动页（`StartupScreen`）中间图标连续点击 5 次会弹出「跳过初始化」确认框（开发/测试用，只给启动页传了 `onSecretTap`，重置进度页没有）：确认后立刻进入界面不再等容器初始化；原生初始化无法中断，会在后台继续跑，容器就绪前 Karin 相关操作可能不可用
- 关于页「检查更新」（设置页顶部的「关于 Karin App」进入；设置页不再单独放应用更新分组）：从 GitHub Release（`KarinJS/KarinApp`，资产名 `Karin-<版本>.apk`，版本号取 tag/资产名）检查新版本，APK 下到应用私有目录 `filesDir/updates/karin-update.apk`（原生 `KarinUpdater` 模块 + FileProvider，权限 `REQUEST_INSTALL_PACKAGES`），更新日志由 `formatReleaseNotes` 整理（release-please 的 `## [版本](compare)` 标题丢掉——弹窗标题就是「发现新版本 v1.1.3」，`### Bug Fixes` → `Bug Fixes:`，条目去掉 `([hash](url))` 短链和行内 markdown），所以弹窗正文是「Bug Fixes:」加分节条目（`Features` / `Performance Improvements` / `⚠ BREAKING CHANGES` 等分节同样是「原名:」+ 条目，不用逐个适配），只取前 500 字并按行截断（`truncateReleaseNotes`），不会把最后一条切成半句；下载日志复用插件页同款 `LogConsole` 面板；下载支持断点续传（半截包 `.part` + 续传信息 `.part.txt` 存 URL/ETag/总大小，续传用 `Range` + `If-Range`，重定向手动跟随，服务端不支持就自动重下），进程被杀后下次点「检查更新」会提示已下载百分比并继续，下载期间由 `UpdateForegroundService`（前台服务 + PARTIAL_WAKE_LOCK + 高性能 WifiLock，通知里显示百分比）保活，JS 侧用 `startDownloadKeepAlive`/`stopDownloadKeepAlive` 把整个下载流程包起来（重试时不能再起前台服务，Android 12+ 会拒绝，所以只复用同一次保活），切后台/息屏不会被系统掐断连接（否则会 Software caused connection abort），断流时 `downloadRelease` 自动等 1.5s/4s 续传重试两次（HTTP 状态码、断点失效、本地文件问题不重试），下载任务弹窗里也有「继续下载」按钮直接续传；完成后弹窗询问是否安装，安装前先停 Karin 并让 proot 优雅退出（超时强杀）再拉起系统安装器；用户不装的话下次检查更新会读本地包比对版本号/sha256（Release 提供 digest 时校验），是最新版就直接弹安装弹窗，否则删掉重下；App 启动时若本地包 versionCode ≤ 当前版本则删除
- 设置页顶部的「关于 Karin App」进入 `AboutScreen`：Karin Logo 下展示 App 版本（副行是 node-karin 版本）；检查更新无更新时用 `Toast` 悬浮提示「当前已是最新版本」，5 秒后自动消失（`useToast` 支持第二个参数指定时长，默认 2400ms）；悬浮提示统一浮在底部导航上方，关于页容器不含导航，用 `Toast` 的 `bottomOffset` 减去 `BOTTOM_NAV_HEIGHT` 对齐；点确认下载后出现「下载任务」悬浮按钮（`UpdateTaskFab`：下载图标 + 进度百分比角标，失败/中断变红色感叹号），点开是 `UpdateTaskSheet` 弹窗——进度条、已下载/总大小（`UpdateState.partial` 跟着每次进度事件更新，不是开始下载时的快照）、状态文字，失败或中断时多一个「继续下载」按钮（`flow.retryDownload`，直接从半截包续传，不用再点检查更新），只有失败或中断时才出现「错误日志」（`LogConsole`）且默认折叠，点标题才展开；只有检查结果不显示日志「GitHub」用 `Linking.openURL`，交给 Android 选择器决定浏览器或 GitHub 客户端；「加入 QQ 群聊」先试 `mqqapi://card/show_pslcard?...&uin=850541480&card_type=group` 深链，失败退回浏览器打开的群官方邀请链接 `https://qm.qq.com/q/so3xck79sc`（换群改 `AboutScreen` 的 `QQ_GROUP_WEB_URL` 即可）
- 更新流程抽成 `useUpdateFlow`（状态机 + 检查/下载/安装动作）与 `UpdateDialogs`（发现新版本/下载完成/需要安装权限三个 `ConfirmDialog`），只有关于页在用；`UpdateState.task` 标记「用户点过下载」，悬浮按钮只在它为真且正在下载/失败时出现，纯粹检查失败不会冒出来；去「安装未知应用」授权页那一步由 `useUpdateFlow` 记下「等待授权」，AppState 回到 active 时自动再调一次 `launchInstaller()`（只拉起安装器，不再重复停容器），仍没授权才重新弹授权提示，所以用户不用回头再点检查更新
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
