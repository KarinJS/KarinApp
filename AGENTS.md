# Karin App Guide

## Project

Android-only React Native app，只服务 node-karin：管理内置 proot 环境与 KarinJS/Karin 进程。已实现 proot 启动、容器内命令执行（karin-ipc daemon）、环境安装、Karin 版本切换、运行日志页（stdout + stdin）；通用终端 / 文件访问 / 内存占用仍是占位值，除非明确要做，别当真实数据源。

## Container Notes

- SELinux 在部分设备禁止 app 私有目录硬链接：硬链接探测失败时 proot 加 `--link2symlink`；pnpm 每次启动强制 `package-import-method=copy`（l2s 影子链接在 `pnpm install -f` 后会坏成 ENOENT）。
- `node-karin init` 只跑一次（标记 `/root/karin/index.mjs` 与 `.env`），它内部的 `pnpm install -f` 不得重复。
- rootfs 已带 Node/npm/pnpm 与 curl、ca-certificates、xz-utils；启动只在容器内跑一次 `apt-get update`，失败只记日志、不阻塞启动。
- 比较 registry 前必须 `normalizeRegistry`（`src/screens/SettingsScreen.tsx`）：npm 读回的值可能多一个结尾 `/`，否则官方源会被误判成自定义源。
- 原生分层：`ProotModule.kt`（bridge + daemon session）、`RootfsInstaller.kt`（解包 rootfs）、`ProotRuntime.kt`（proot argv/env + guest 进程）、`IpcProtocol.kt`（帧编解码）、`AppPluginImportModule.kt`（选本地 app 插件文件并复制进 rootfs）、`ShizukuKeepAlive.kt`（Shizuku 授权 + 借 adb 身份写保活白名单）、`cpp/karin-ipc.c`（容器内 daemon）、`KarinGitModule.kt` + `KarinGitService.kt` + `KarinGitNative.kt` + `cpp/karin-git.cpp`（宿主进程内 libgit2，把 `/root/karin/plugins/*` 映射到 rootfs 真实路径再走 JNI，单入口 `execute(action, path, optionsJson, operationId, callback)` 返回 JSON）。
- Git 不在容器里跑：插件 clone / 版本切换都用宿主 libgit2，rootfs 不装 git。原生产物由 `scripts/build-native-git.ps1` 交叉编译（libgit2 1.9.1 + mbedTLS 静态链入，HTTPS=mbedTLS，SSH / GSSAPI / NTLM / CLI / 测试全关，SONAME=OFF 但产物必须叫 `libgit2.so`——SONAME 就是文件名，改名加载不到），输出 `jniLibs/arm64-v8a/libgit2.so` 与 `libkarin_git.so`，必须提交（CI 的 `preBuild` → `buildGitBridge` 也要它）。HTTPS 证书用 `KarinGitService` 导出的系统 TrustManager 写成的 PEM，不关校验。
- 子进程默认 stdin 是 `/dev/null`；只有带 `EXEC_FLAG_STDIN`（EXEC 帧尾的 flags 字节）启动的命令才有 stdin 管道，之后用 `REQ_WRITE` 帧写（写端非阻塞、256KB 上限，子进程不读也不卡 daemon）。Karin 常驻进程走这条，控制台输入才能进 `process.stdin`。
- 停止一律先礼后兵，策略只在容器内 daemon（`karin-ipc.c`）里，宽限常量 `GRACEFUL_EXIT_MS = 10s`：`REQ_KILL`（`kill` 帧）先对进程组 `killpg` SIGTERM，宽限期内没退出才 SIGKILL（主循环按最近的到点时刻裁剪 poll 超时，到点即强杀）；daemon 退出前的 `shutdown_all()`（QUIT 帧、stdin EOF、daemon 自己收到 SIGTERM）同样先 SIGTERM 等 10 秒，等待期间继续抽走 stdout/stderr，否则写满管道的子进程会卡在 write 上退不出来。所以退出码正常是 143（TERM），卡死才是 137。调用方只负责等：`karinService.stop()` 先 `probe()` 跳过空等，然后发 `kill` 帧等 exit 事件（`STOP_GRACE_MS + STOP_FORCE_MS` 兜底）；原生 `stopKeeper` 一律等 `GRACEFUL_STOP_TIMEOUT_MS = 12s`，`force` 只跳过 QUIT 帧、不缩短宽限期（强杀 proot 会让 tracee 变孤儿进程继续占着 rootfs）。

## Stack

- React Native 0.87 / React 19 / TypeScript；Android 为主，iOS 文件已删（不要恢复）
- 入口 `index.js` → `src/App.tsx`；安全区用 `react-native-safe-area-context`
- 图标用 `lucide-react-native` + `react-native-svg`；代码高亮用 `lowlight`（`CodeViewer`），编辑器是纯 `TextInput`（`CodeEditor`，不做透明层高亮，滚动会错位）
- Node.js >= 22.11

## Current UI

- 底部导航 Home / Plugins / Settings；明暗主题跟随系统。`BottomNav` 是悬浮玻璃底栏（64dp 控件 + 上下各 8dp + 系统底部 inset），`useBottomNavInset` 统一提供页面避让高度；三个主页面滚动内容延伸至底栏背后，日志 / 文件 / 设置子页保留底部空间。背景模糊由 `KarinGlassView` 只采样 `nativeID="karin-tab-scene"` 的独立页面视图（必须 `collapsable={false}`，不能把导航放进采样源），Android 12+ 用 RenderEffect、7–11 用 RenderScript，失败保留半透明底色。系统导航栏透明，`MainActivity` 同步手势条明暗色；不要恢复根 SafeAreaView 的 bottom padding 导致重复留白。切换动画尊重系统减少动画设置。
- Home：Karin 运行状态卡、内存占位、安卓版本（`Platform.constants.Release`，副行 API 级别；只有 arm64，不展示架构）、运行日志与文件管理入口；右上容器指示器（重启 / 强制重启），右下电源按钮独立控制 Karin
- 运行日志页 `TerminalScreen`：双模式（标签顺序：控制台、历史日志），默认「控制台」显示 Karin 常驻进程 stdout/stderr，不做通用终端；`karinLogService` 在 App 挂载时开始捕获（2000 行环形缓冲、~120ms 合并通知），所以进页面前的历史也在；「历史日志」读容器内 log4js 落盘文件（`karinLogFileService`，`/root/karin/@karinjs/logs/logger.<日期>.log`）：当天用 `tail -F` 实时跟随（自带末尾 2000 行回放，跨天不自动换文件，切日期/点刷新重启跟随），历史日期一次性 `tail -n` 读取；文件行是纯文本无 ANSI 色，`formatLogFileLine` 按 `[hh:mm:ss.SSS][级别]` 前缀的级别重新上色（与 karin web 端历史日志同思路，色号 TRAC 蓝/DEBU 青/INFO 绿/WARN 黄/ERRO 红/FATA 品红/MARK 灰）。ANSI 解析在 `src/utils/ansi.ts`（16 色 + bold/dim/underline，`38;5;n` 只映射前 16 色，真彩色与光标/清屏/OSC 序列丢弃），取色按明暗主题在渲染时选，切主题不用重新解析。贴底跟随的偏移量用「内容高度 − 可视高度」算，不要用 `FlatList.scrollToEnd`（它按已量出的行高估算，长行折行后估算偏小、只能停在那一行）；跟随状态只由用户拖拽 / 惯性结束事件改，程序化贴底触发的 `onScroll` 不算。日志行是嵌套 `Text` 上色，不挂 `selectable`（每行是各自独立的原生文本视图，系统选区跨不过行边界，挂上反而只选到一个词）；长按行或点表头 ListChecks 进入 selecting 整行多选（GitHub 手机版那种：长按即选中该行），进入时暂停贴底跟随、退出按进入前状态恢复，点行切换、长按按锚点选区间，CheckCheck 全选、Copy 按 id 取行拼纯文本写剪贴板（clipboardService，RN 核心 Clipboard 已弃用、直接 import 会弹警告），系统返回键先退出多选。输入框在 Android 15+（targetSdk 35+ 强制 edge-to-edge）下 adjustResize 不再缩小窗口，输入法会盖住输入行，TerminalScreen 用 Keyboard 事件 + 根容器 measureInWindow 算 paddingBottom 把输入行顶到输入法上方（窗口本来就会缩的设备算出来是 0，不会重复抬）。底部输入框回车把一行写进 node-karin 的 stdin（本地回显 `$ 命令`），Karin 未运行时禁用
- Settings：分组为运行环境 / 网络 / 应用 / 危险操作（每个分组都带小标题，不要再加无标题分组）。显示真实 node-karin 版本，底部弹窗拉 npm 版本列表（`npm view node-karin versions`，走 `packageVersions` 缓存）并用 `pnpm i node-karin@<version>` 切换；「依赖管理」（`DependencyScreen`，不再放插件页）列 `/root/karin/package.json` 里的依赖：node-karin 置顶、其余按字母序，每行的版本号点开 `DependencyVersionSheet` 选版本或手填，改动进 pending、标题右侧「保存 N」才 `pnpm i`（`updateKarinDependencySpecs`；devDependencies 必须走 `pnpm i -D`，否则会被挪进 dependencies），版本列表走 `services/packageVersions.ts` 的 15 分钟内存缓存，头部只有一个刷新按钮：点按只重读 package.json、长按清空版本缓存后才重新请求 npm（弹层里另有单包的「强制刷新」）；「GitHub 加速」只有一个输入框（placeholder 示意 `https://gh-proxy.com/`）+ 保存按钮，留空即直连，值存 `/root/.karinapp/settings.json`，只对 GitHub 域名生效（`pluginService` 的 clone/fetch、app 插件 curl 下载、`MarkdownView` 的 README 图片），命令是同步拼的，所以启动 / 进插件页前先 `loadAppSettings()`
- 保活设置页 `KeepAliveScreen`（设置页「保活设置」进入）：集中检查保活权限并按需引导，启动 Karin 只主动申请通知权限，其余不弹窗。检查项：通知权限（`PermissionsAndroid.check/request`）、电池优化白名单（`ProotModule.isIgnoringBatteryOptimizations/requestIgnoreBatteryOptimizations`，拉系统弹窗）、ADB/Root（`isRootAvailable` 用 `su -c` 探测；有 root 时「一键保活」走 `applyRootKeepAlive` 写 deviceidle 白名单 + appops（RUN_ANY_IN_BACKGROUND/START_FOREGROUND））、Shizuku（`ShizukuKeepAlive.kt` + `dev.rikka.shizuku:api/provider` 依赖 + manifest 里的 `ShizukuProvider`；`getShizukuStatus` 一次取回未安装 / 未运行 / 未授权，授权走 `Shizuku.requestPermission` + 结果监听（60s 超时按未授权），授权后「一键保活」`applyShizukuKeepAlive` 跑与 root 相同的命令——Shizuku API 13 把 `newProcess` 收成私有，只能反射调用，见 `proguard-rules.pro` 的 keep 规则；没有 root 时还显示等价 adb 命令并可复制）。`KarinForegroundService` 持 PARTIAL_WAKE_LOCK + WifiLock（锁屏 Doze 冻结 CPU 是 node 被暂停的根源），START_STICKY。状态在 AppState 回到 active 时刷新；页内还有厂商 ROM（自启动/无限制用电）文字提示
- Plugins：统计行下面是搜索框（匹配插件名或市场介绍，不区分大小写，和筛选叠加生效，搜索时统计行显示 `搜索「x」· N 个结果`，右侧 `X` 清空）；筛选是全部 / 已安装 / 未安装常驻 + 可展开分类，分类由 `pluginService` 从市场标签（`category`/`categories`/`tags`）归一，市场新增分类不用改 UI。app 插件是多文件集合，统一落在 `/root/karin/plugins/karin-plugin-example`，另有固定的 `karin-plugin-example` 目录条目（只能卸载）；涉及 2 个以上文件的安装和卸载都弹勾选列表（默认全不勾）；归属用 `/root/karin/.karin-app-plugins.json` 里的文件名 + sha256 判断，不按插件名建目录，遇到同名外来文件弹「替换 / 重命名」；`karin-plugin-example` 详情页的「安装」先弹安装方式：本地文件走原生 `AppPluginImportModule`（SAF 选文件后直接复制进 rootfs 的 `APP_PLUGIN_ROOTFS_DIR`，8MB 上限），直链下载用 `manualAppPlugin` 现造单文件 app 条目并复用市场那套 curl 下载（直链取不到文件名时用 `renames` 的 `*` 兜底），直链表单居中显示、键盘弹出时按实测高度上移让位；两种方式都当未知来源（`InstallOptions.thirdParty`，不写 `.karin-app-plugins.json`），文件列表显示「未知来源」。插件列表的安装状态由「本地 + 市场」共同决定：本地探测 node_modules（`karin-plugin-*` / `@karinjs/plugin-*` / `@scope/karin-plugin-*`）和 `plugins/` 下的目录，市场里没有的本地条目补成「未知来源」且可直接卸载；已安装插件的详情页多一个「切换版本」（`pluginVersionService`）：npm 走 registry 版本列表（`packageVersions` 缓存，`pnpm i <name>@<version> --save-exact`，按 `/root/karin/package.json` 里的分组带 `-D` / `-O`），Git 走仓库提交历史（先 `--unshallow` 补浅克隆，远程读不到时只留本地历史并给一句提示；切换前要求已跟踪文件干净、`checkout --detach <完整哈希>` 后重装依赖）；`canSwitchPluginVersion` 只放行已安装且来源明确的插件，未知来源与 app 插件不显示这个按钮；插件页顶部「安装插件」先选「从 Git 克隆 / 从文件导入」；Git 使用仓库地址 / 分支 / 目录名表单，分支留空时克隆默认分支，非空目录必须等任务警告确认覆盖。ZIP 导入走 `pluginArchiveImport` + 原生 `AppPluginImportModule`：根目录必须有 package.json，name 为 karin-plugin-* 或 @scope/karin-plugin-*，scope 从落地目录名移除；karin-plugin-example 与 karin-plugin-examplee 禁止导入；先校验缓存 ZIP 再解压到临时目录，确认覆盖后替换目标，失败保留旧目录。ZIP 上限 64MB、展开 256MB、package.json 1MB、20000 条目，拒绝目录穿越和重复路径
- 插件任务由 App 持有 `usePluginTasks`（切底部页面不丢任务），唯一 id 保留重复安装的历史；状态 running / warning / completed / failed / cancelled，warning 挂起操作，点击标签才弹「是 / 否」确认。下载图标 FAB 显示任务数量，`PluginTaskCard` 可展开日志和终止；只有 completed 可从任意方向横滑删除。取消等待原生清理/进程退出后标已终止，进行中和警告只允许一个操作；原生导入用 taskId + cancelImport / finishImport 清理临时文件。
- 启动页 `StartupScreen`：中间图标连点 5 次弹「跳过初始化」确认框（开发用，只给启动页传了 `onSecretTap`）；确认后立刻进界面，原生初始化在后台继续跑，容器就绪前 Karin 相关操作可能不可用
- 关于页 `AboutScreen`（设置页「应用」分组里「关于 Karin App」进入）：App 版本 + node-karin 版本；检查更新没新版时用 `Toast` 提示「当前已是最新版本」（5s 自动消失，`useToast` 第二个参数可调时长；关于页容器不含底部导航，弹层用 `bottomOffset` 减 `BOTTOM_NAV_HEIGHT` 对齐）。「检查更新」从 GitHub Release（`KarinJS/KarinApp`，资产 `Karin-<版本>.apk`）取版本，APK 下到 `filesDir/updates/karin-update.apk`（原生 `KarinUpdater` + FileProvider + `REQUEST_INSTALL_PACKAGES`）。下载用 `.part` 断点续传（URL/ETag/总大小存 `.part.txt`，续传用 `Range` + `If-Range`，重定向手动跟随，服务端不支持就重下），`UpdateForegroundService` 保活（前台服务 + PARTIAL_WAKE_LOCK + 高性能 WifiLock + 通知百分比；JS 侧 `startDownloadKeepAlive`/`stopDownloadKeepAlive` 把整段包起来，重试时不能重复起前台服务，Android 12+ 会拒），断流时自动等 1.5s / 4s 续传重试两次（HTTP 状态码、断点失效、本地文件问题不重试），任务面板里也能点「继续下载」。安装前先停 Karin 并让 proot 优雅退出（超时强杀）再拉系统安装器；去「安装未知应用」授权后 AppState 回到 active 会自动再调一次 `launchInstaller()`（只拉安装器，不再重复停容器），仍没授权才重新弹提示；用户不装则下次检查更新比对本地包版本号 / sha256 决定直接安装还是重下；App 启动时本地包 versionCode ≤ 当前版本就删。发现新版本的正文由 `formatReleaseNotes` 去掉 `##` 标题 / 哈希链接 / Full Changelog，再 `truncateReleaseNotes` 按行截断。状态机在 `useUpdateFlow`，三个弹窗在 `UpdateDialogs`（发现新版本 / 下载完成 / 需要安装权限），悬浮按钮与面板是 `UpdateTaskFab` / `UpdateTaskSheet`；`UpdateState.task` 标记用户点过下载，纯检查失败不冒悬浮按钮
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
