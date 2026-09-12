# Karin App Guide

## Project

Android-only React Native app，只服务 node-karin：管理内置 proot 环境与 KarinJS/Karin 进程。已实现 proot 启动、容器内命令执行（karin-ipc daemon）、环境安装、Karin 版本切换、运行日志页（stdout + stdin）；通用终端 / 文件访问 / 内存占用仍是占位值，除非明确要做，别当真实数据源。

## Container Notes

- SELinux 在部分设备禁止 app 私有目录硬链接：硬链接探测失败时 proot 加 `--link2symlink`；pnpm 每次启动强制 `package-import-method=copy`（l2s 影子链接在 `pnpm install -f` 后会坏成 ENOENT）。
- `node-karin init` 只跑一次（标记 `/root/karin/index.mjs` 与 `.env`），它内部的 `pnpm install -f` 不得重复。
- rootfs 已带 Node/npm/pnpm 与 curl、ca-certificates、xz-utils；启动只在容器内跑一次 `apt-get update`，失败只记日志、不阻塞启动。
- 比较 registry 前必须 `normalizeRegistry`（`src/screens/SettingsScreen.tsx`）：npm 读回的值可能多一个结尾 `/`，否则官方源会被误判成自定义源。
- 原生分层：`ProotModule.kt`（bridge + daemon session）、`RootfsInstaller.kt`（解包 rootfs）、`ProotRuntime.kt`（proot argv/env + guest 进程）、`IpcProtocol.kt`（帧编解码）、`cpp/karin-ipc.c`（容器内 daemon）。
- 子进程默认 stdin 是 `/dev/null`；只有带 `EXEC_FLAG_STDIN`（EXEC 帧尾的 flags 字节）启动的命令才有 stdin 管道，之后用 `REQ_WRITE` 帧写（写端非阻塞、256KB 上限，子进程不读也不卡 daemon）。Karin 常驻进程走这条，控制台输入才能进 `process.stdin`。

## Stack

- React Native 0.87 / React 19 / TypeScript；Android 为主，iOS 文件已删（不要恢复）
- 入口 `index.js` → `src/App.tsx`；安全区用 `react-native-safe-area-context`
- 图标用 `lucide-react-native` + `react-native-svg`；代码高亮用 `lowlight`（`CodeViewer`），编辑器是纯 `TextInput`（`CodeEditor`，不做透明层高亮，滚动会错位）
- Node.js >= 22.11

## Current UI

- 底部导航 Home / Plugins / Settings；明暗主题跟随系统
- Home：Karin 运行状态卡、内存占位、安卓版本（`Platform.constants.Release`，副行 API 级别；只有 arm64，不展示架构）、运行日志与文件管理入口；右上容器指示器（重启 / 强制重启），右下电源按钮独立控制 Karin
- 运行日志页 `TerminalScreen`：只显示 Karin 常驻进程 stdout/stderr，不做通用终端。`karinLogService` 在 App 挂载时开始捕获（2000 行环形缓冲、~120ms 合并通知），所以进页面前的历史也在；ANSI 解析在 `src/utils/ansi.ts`（16 色 + bold/dim/underline，`38;5;n` 只映射前 16 色，真彩色与光标/清屏/OSC 序列丢弃），取色按明暗主题在渲染时选，切主题不用重新解析。贴底跟随的偏移量用「内容高度 − 可视高度」算，不要用 `FlatList.scrollToEnd`（它按已量出的行高估算，长行折行后估算偏小、只能停在那一行）；跟随状态只由用户拖拽 / 惯性结束事件改，程序化贴底触发的 `onScroll` 不算。日志行是嵌套 `Text` 上色 + `Text selectable`（走系统文本选择）。底部输入框回车把一行写进 node-karin 的 stdin（本地回显 `$ 命令`），Karin 未运行时禁用
- Settings：显示真实 node-karin 版本，底部弹窗拉 npm 版本列表（`npm view node-karin versions`）并用 `pnpm i node-karin@<version>` 切换；「GitHub 加速」只有一个输入框（placeholder 示意 `https://gh-proxy.com/`）+ 保存按钮，留空即直连，值存 `/root/.karinapp/settings.json`，只对 GitHub 域名生效（`pluginService` 的 clone/fetch、app 插件 curl 下载、`MarkdownView` 的 README 图片），命令是同步拼的，所以启动 / 进插件页前先 `loadAppSettings()`
- Plugins：统计行下面是搜索框（匹配插件名或市场介绍，不区分大小写，和筛选叠加生效，搜索时统计行显示 `搜索「x」· N 个结果`，右侧 `X` 清空）；筛选是全部 / 已安装 / 未安装常驻 + 可展开分类，分类由 `pluginService` 从市场标签（`category`/`categories`/`tags`）归一，市场新增分类不用改 UI。app 插件是多文件集合，统一落在 `/root/karin/plugins/karin-plugin-example`，另有固定的 `karin-plugin-example` 目录条目（只能卸载）；涉及 2 个以上文件的安装和卸载都弹勾选列表（默认全不勾）；归属用 `/root/karin/.karin-app-plugins.json` 里的文件名 + sha256 判断，不按插件名建目录，遇到同名外来文件弹「替换 / 重命名」
- 启动页 `StartupScreen`：中间图标连点 5 次弹「跳过初始化」确认框（开发用，只给启动页传了 `onSecretTap`）；确认后立刻进界面，原生初始化在后台继续跑，容器就绪前 Karin 相关操作可能不可用
- 关于页 `AboutScreen`（设置页顶部「关于 Karin App」进入）：App 版本 + node-karin 版本；检查更新没新版时用 `Toast` 提示「当前已是最新版本」（5s 自动消失，`useToast` 第二个参数可调时长；关于页容器不含底部导航，弹层用 `bottomOffset` 减 `BOTTOM_NAV_HEIGHT` 对齐）。「检查更新」从 GitHub Release（`KarinJS/KarinApp`，资产 `Karin-<版本>.apk`）取版本，APK 下到 `filesDir/updates/karin-update.apk`（原生 `KarinUpdater` + FileProvider + `REQUEST_INSTALL_PACKAGES`）。下载用 `.part` 断点续传（URL/ETag/总大小存 `.part.txt`，续传用 `Range` + `If-Range`，重定向手动跟随，服务端不支持就重下），`UpdateForegroundService` 保活（前台服务 + PARTIAL_WAKE_LOCK + 高性能 WifiLock + 通知百分比；JS 侧 `startDownloadKeepAlive`/`stopDownloadKeepAlive` 把整段包起来，重试时不能重复起前台服务，Android 12+ 会拒），断流时自动等 1.5s / 4s 续传重试两次（HTTP 状态码、断点失效、本地文件问题不重试），任务面板里也能点「继续下载」。安装前先停 Karin 并让 proot 优雅退出（超时强杀）再拉系统安装器；去「安装未知应用」授权后 AppState 回到 active 会自动再调一次 `launchInstaller()`（只拉安装器，不再重复停容器），仍没授权才重新弹提示；用户不装则下次检查更新比对本地包版本号 / sha256 决定直接安装还是重下；App 启动时本地包 versionCode ≤ 当前版本就删。发现新版本的正文由 `formatReleaseNotes` 去掉 `##` 标题 / 哈希链接 / Full Changelog，再 `truncateReleaseNotes` 按行截断。状态机在 `useUpdateFlow`，三个弹窗在 `UpdateDialogs`（发现新版本 / 下载完成 / 需要安装权限），悬浮按钮与面板是 `UpdateTaskFab` / `UpdateTaskSheet`；`UpdateState.task` 标记用户点过下载，纯检查失败不冒悬浮按钮
- `UpdateTaskSheet` 显示进度条、已下载/总大小（`UpdateState.partial` 跟着进度事件更新）、状态文字，失败或中断才出现「错误日志」（`LogConsole`，默认折叠）；只有检查结果不显示日志
- 关于页外链：「GitHub」用 `Linking.openURL` 交给 Android 选择器；「加入 QQ 群聊」先试 `mqqapi://card/show_pslcard?...&uin=850541480&card_type=group` 深链，失败退回 `https://qm.qq.com/q/so3xck79sc`（换群改 `AboutScreen` 的 `QQ_GROUP_WEB_URL`）

区分两类状态，不要混：

- **Container state**：proot 生命周期（`starting` / `running` / `stopped`）
- **Karin state**：Karin 进程生命周期与运行计时

## UI Direction

- 面向紧凑的 Android 手机屏，风格参考 KernelSU / LSPosed：密集信息行 + 小状态卡，不要大 hero 卡或桌面式 KPI 面板
- 图标用 Lucide，不要 emoji 或临时文字符号；从 `lucide-react-native` 包根导入（Metro 0.87 解析不了 `lucide-react-native/icons/home` 这类子路径）
- Settings 留在底部导航，不要再加标题栏设置按钮

## Commands

```sh
npm start
npm run android
npx tsc --noEmit
npm run lint -- --no-cache
npm test -- --runInBand
```

部分本地安装里 Jest 会失败（RN preset 走 pnpm 风格路径、把 ESM 当 CommonJS）；UI 改动至少过 tsc + lint。

## Change Rules

- 保留现有 Android 包名、启动图标与 Android-only 变更；不要恢复已删的 iOS 文件
- 原生 / proot 集成留在 service 边界后面，不要把 shell 或进程逻辑写进 UI 组件
- 占位值只在接入真实原生数据源时替换
- 用 tsc + ESLint 验证，本地 preset 正常时再跑 Jest