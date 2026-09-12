import {DeviceEventEmitter, NativeModules} from 'react-native';
import {proxiedUrl} from './appSettings';
import {karinService} from './karinService';
import {prootController} from './prootController';

/** 更新源：Karin App 自己的 GitHub Releases */
const RELEASE_API = 'https://api.github.com/repos/KarinJS/KarinApp/releases/latest';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_LOG_LINES = 200;
/** 下载日志按百分比合并，避免几百行刷屏 */
const LOG_PERCENT_STEP = 5;
/** 连接被掐断（后台化最典型）时自动续传重试的次数与等待时间 */
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1500, 4000];

type AppInfo = {versionName: string; versionCode: number};
type ApkInfo = {versionName: string; versionCode: number; size: number; sha256: string} | null;
type DownloadResult = {size: number; sha256: string};
/** 上次没下完的半截包：已下载字节数与总大小（总大小未知时为 0） */
export type PartialInfo = {received: number; total: number; url: string};

/** 安装结果：launched=已拉起系统安装器，permission=缺少「安装未知应用」权限，failed=安装失败 */
export type InstallResult = 'launched' | 'permission' | 'failed';

type NativeUpdater = {
  getAppInfo: () => Promise<AppInfo>;
  inspectApk: () => Promise<ApkInfo>;
  inspectPartial: () => Promise<PartialInfo | null>;
  downloadApk: (url: string) => Promise<DownloadResult>;
  startDownloadKeepAlive: () => Promise<boolean>;
  stopDownloadKeepAlive: () => Promise<boolean>;
  deleteApk: () => Promise<boolean>;
  installApk: () => Promise<InstallResult>;
  openInstallPermissionSettings: () => Promise<boolean>;
};

const native = NativeModules.KarinUpdater as NativeUpdater | undefined;

export type UpdateRelease = {
  /** 去掉 v 前缀的版本号，例如 1.2.0 */
  version: string;
  versionCode: number;
  notes: string;
  size: number;
  downloadUrl: string;
  /** Release 提供 digest 时才有值；空串表示无法校验哈希 */
  sha256: string;
};

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

export type UpdateState = {
  phase: UpdatePhase;
  message: string;
  logs: string[];
  /** 0~1，未知为 -1 */
  progress: number;
  release: UpdateRelease | null;
  /** 半截包信息：下载中就是本次已收到的字节，没有半截包时为 null */
  partial: {received: number; total: number} | null;
  /** 用户已经点过下载、存在下载任务（用来决定「下载任务」悬浮按钮是否出现），检查更新时重置 */
  task: boolean;
  appVersion: string;
};

type GithubAsset = {name?: string; browser_download_url?: string; size?: number; digest?: string | null};
type GithubRelease = {tag_name?: string; body?: string | null; assets?: GithubAsset[]};

const listeners = new Set<(value: UpdateState) => void>();
let state: UpdateState = {phase: 'idle', message: '', logs: [], progress: 0, release: null, partial: null, task: false, appVersion: ''};

const notify = () => listeners.forEach(listener => listener(state));

const setState = (patch: Partial<UpdateState>) => {
  state = {...state, ...patch};
  notify();
};

const pushLog = (line: string) => {
  const logs = [...state.logs, line];
  if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
  setState({logs});
};

/** 订阅更新状态；返回取消订阅函数（设置页卸载后下载仍会继续，进度不会丢）。 */
export function subscribeUpdate(listener: (value: UpdateState) => void) {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

export const getUpdateState = () => state;

export const formatSize = (bytes: number) => {
  if (!bytes || bytes <= 0) return '未知大小';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

/** 与 android/app/build.gradle 的 computedVersionCode 保持一致，用于按 tag 推算 versionCode。 */
export const versionCodeOf = (version: string) => {
  const parts = version.split('.').map(part => Number.parseInt(part, 10) || 0);
  return (parts[0] ?? 0) * 1_000_000 + (parts[1] ?? 0) * 1000 + (parts[2] ?? 0);
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 配了加速前缀就先走加速，失败再直连；没配就只直连。 */
const urlCandidates = (url: string) => {
  const proxied = proxiedUrl(url);
  return proxied === url ? [url] : [proxied, url];
};

/** 选 APK 资产：优先 arm64/v8a（本项目只发 arm64），其次 universal，最后第一个 .apk。 */
const rankAsset = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes('arm64') || lower.includes('v8a')) return 3;
  if (lower.includes('universal')) return 2;
  return 1;
};

/** 去掉行内 markdown：链接只留文字，去掉加粗/行内代码标记。 */
const stripMarkdown = (text: string) =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .trim();

/** 提交条目结尾的短链：`标题 ([abc1234](https://…))` → `标题` */
const stripCommitSuffix = (text: string) => text.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)\s*$/, '').trim();

/**
 * 把 release-please 生成的更新日志整理成弹窗里显示的纯文本：
 * `## [1.1.3](…)` 这种二级标题就是版本行，交给弹窗标题，这里丢掉；
 * `### Bug Fixes` 这类三级标题变成 `Bug Fixes:` 分节名；`* 条目 ([hash](url))` 只留条目文字。
 * 所以最终显示成：标题「发现新版本 v1.1.3」+「Bug Fixes:」+ 一行行条目。
 */
export const formatReleaseNotes = (body: string) => {
  const lines: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^-{3,}$/.test(line)) continue;
    const heading = line.match(/^#+\s+(.+)$/);
    if (heading) {
      /** 二级标题是 release-please 的版本行 + 日期，弹窗标题已经写了版本，不用重复 */
      if (/^##\s/.test(line)) continue;
      const name = stripMarkdown(heading[1]);
      if (!name) continue;
      if (lines.length > 0) lines.push('');
      lines.push(`${name}:`);
      continue;
    }
    const item = stripMarkdown(stripCommitSuffix(line.replace(/^[*+-]\s+/, '')));
    /** release-please 结尾的「Full Changelog: …compare…」对用户没意义 */
    if (!item || /^full changelog[:：]/i.test(item)) continue;
    lines.push(item);
  }
  return lines.join('\n').trim();
};

/** 弹窗里只展示前面一段更新日志：按行截断，免得把最后一个条目切成半句。 */
export const truncateReleaseNotes = (notes: string, limit = 500) => {
  if (notes.length <= limit) return notes;
  const head = notes.slice(0, limit);
  const lastBreak = head.lastIndexOf('\n');
  return `${(lastBreak > 0 ? head.slice(0, lastBreak) : head).trimEnd()}…`;
};

const parseRelease = (data: GithubRelease): UpdateRelease | null => {
  const asset = (data.assets ?? [])
    .filter(item => (item.name ?? '').toLowerCase().endsWith('.apk') && item.browser_download_url)
    .sort((a, b) => rankAsset(b.name ?? '') - rankAsset(a.name ?? ''))[0];
  const tagVersion = (data.tag_name ?? '').replace(/^[vV]/, '').trim();
  /** 工作流把资产命名为 Karin-1.2.0.apk：tag 不是纯版本号时用资产名兜底 */
  const version = /^\d+(\.\d+)*$/.test(tagVersion)
    ? tagVersion
    : (asset?.name ?? '').match(/(\d+(?:\.\d+)+)/)?.[1] ?? '';
  if (!version || !asset?.browser_download_url) return null;
  const digest = (asset.digest ?? '').toLowerCase();
  return {
    version,
    versionCode: versionCodeOf(version),
    notes: formatReleaseNotes(data.body ?? ''),
    size: asset.size ?? 0,
    downloadUrl: asset.browser_download_url,
    sha256: digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : '',
  };
};

const fetchLatestRelease = async (): Promise<UpdateRelease | null> => {
  let lastError: unknown = new Error('检查更新失败');
  for (const url of urlCandidates(RELEASE_API)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {Accept: 'application/vnd.github+json', 'User-Agent': 'KarinApp'},
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
      return parseRelease((await response.json()) as GithubRelease);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

/** 本地已下载的安装包是不是这次要装的版本：版本号对得上，且（有哈希时）哈希一致。 */
const isLocalCurrent = (local: NonNullable<ApkInfo>, release: UpdateRelease) =>
  local.versionCode > 0 &&
  local.versionCode >= release.versionCode &&
  (!release.sha256 || local.sha256.toLowerCase() === release.sha256);

/** 断点进度：0~1，总大小未知时为 -1 */
const partialRatio = (partial: {received: number; total: number} | null) =>
  partial && partial.total > 0 ? Math.min(1, partial.received / partial.total) : -1;

const partialPercent = (partial: {received: number; total: number} | null) => {
  const ratio = partialRatio(partial);
  return ratio >= 0 ? Math.floor(ratio * 100) : 0;
};

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** HTTP 状态码、断点失效、本地文件问题重试也没用；断流、超时、连接被系统掐断才值得续传重试。 */
const worthRetry = (error: unknown) => {
  const message = messageOf(error);
  return !/HTTP \d{3}/.test(message) && !message.includes('断点已失效') && !message.includes('无法');
};

const downloadRelease = async (updater: NativeUpdater, release: UpdateRelease) => {
  let lastError: unknown = new Error('下载失败');
  let result: DownloadResult | null = null;
  let loggedPercent = -1;
  const subscription = DeviceEventEmitter.addListener(
    'KarinUpdaterProgress',
    (event: {received?: number; total?: number}) => {
      const total = (event.total ?? 0) > 0 ? (event.total as number) : release.size;
      const received = event.received ?? 0;
      const ratio = total > 0 ? Math.min(1, received / total) : -1;
      /** 断点信息跟着进度一起更新，弹窗里的「已下载 x / y」才不会停在开始下载时的快照上 */
      setState({progress: ratio, partial: total > 0 ? {received, total} : null});
      const percent = ratio >= 0 ? Math.floor(ratio * 100) : -1;
      if (percent < 0) {
        pushLog(`已下载 ${formatSize(received)}`);
      } else if (percent >= loggedPercent + LOG_PERCENT_STEP) {
        loggedPercent = percent;
        pushLog(`下载中 ${percent}%（${formatSize(received)} / ${formatSize(total)}）`);
      }
    },
  );
  try {
    for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS && !result; attempt += 1) {
      if (attempt > 0) {
        const wait = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
        pushLog(`连接中断，${Math.round(wait / 1000)} 秒后自动续传（第 ${attempt + 1}/${DOWNLOAD_ATTEMPTS} 次）`);
        await delay(wait);
        loggedPercent = -1;
      }
      for (const url of urlCandidates(release.downloadUrl)) {
        try {
          pushLog(`${attempt > 0 ? '继续下载' : '开始下载'}：${url}`);
          result = await updater.downloadApk(url);
          break;
        } catch (error) {
          lastError = error;
          pushLog(`下载失败：${messageOf(error)}`);
        }
      }
      if (!result && !worthRetry(lastError)) break;
    }
  } finally {
    subscription.remove();
  }
  if (!result) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  pushLog(`下载完成，共 ${formatSize(result.size)}`);
  if (release.sha256) {
    if (result.sha256.toLowerCase() !== release.sha256) {
      await updater.deleteApk().catch(() => {});
      throw new Error('安装包校验失败（sha256 不一致），已删除，请重试');
    }
    pushLog('sha256 校验通过');
  } else {
    pushLog('Release 未提供 sha256，跳过哈希校验');
  }
};

/**
 * 检查更新：比对 GitHub Release 与当前版本。本地已有最新安装包时直接进入 ready（可安装），
 * 有新版本则停在 available，等用户确认后调用 [downloadUpdate]。
 */
export async function checkForUpdate(): Promise<void> {
  if (!native) throw new Error('KarinUpdater 原生模块不可用，请重新编译安装应用');
  if (state.phase === 'checking' || state.phase === 'downloading') return;
  if (!state.appVersion) await refreshAppInfo();
  setState({phase: 'checking', message: '正在检查更新…', logs: [], progress: 0, release: null, partial: null, task: false});
  pushLog(`当前版本 v${state.appVersion || '未知'}`);
  try {
    const release = await fetchLatestRelease();
    if (!release) throw new Error('最新 Release 里没有可用的 APK');
    if (!(release.versionCode > versionCodeOf(state.appVersion))) {
      pushLog(`没有可用更新（最新 v${release.version}）`);
      setState({phase: 'idle', message: `已是最新版本 v${state.appVersion}`, partial: null});
      return;
    }
    pushLog(`发现新版本 v${release.version}（${formatSize(release.size)}）`);
    /** 上次没装成的安装包还在私有目录里：确认是最新版就直接进入待安装，否则等下载时替换 */
    const local = await native.inspectApk();
    if (local && isLocalCurrent(local, release)) {
      pushLog('本地已有该版本安装包，跳过下载');
      setState({phase: 'ready', message: `v${release.version} 已下载，可安装`, release, progress: 1, partial: null});
      return;
    }
    if (local) pushLog(`本地安装包 v${local.versionName || '未知'} 不是最新版本`);
    /** 上次被网络中断或进程被杀留下的半截包：磁盘上有续传信息就能接着下 */
    const partial = await native.inspectPartial().catch(() => null);
    if (partial && partial.received > 0) {
      pushLog(`检测到未完成的下载：${formatSize(partial.received)}${partial.total > 0 ? ` / ${formatSize(partial.total)}` : ''}`);
      setState({
        phase: 'available',
        message: `发现新版本 v${release.version}（已下载 ${partialPercent(partial)}%，可继续）`,
        release,
        progress: Math.max(0, partialRatio(partial)),
        partial,
      });
      return;
    }
    setState({phase: 'available', message: `发现新版本 v${release.version}`, release, progress: 0, partial: null});
  } catch (error) {
    pushLog(`失败：${messageOf(error)}`);
    setState({phase: 'error', message: `检查更新失败：${messageOf(error)}`});
  }
}

/** 下载已发现的更新（用户确认后调用）；已有最新安装包时直接复用，不再重复下载。 */
export async function downloadUpdate(): Promise<void> {
  if (!native || state.phase === 'downloading') return;
  const release = state.release;
  if (!release) return;
  setState({task: true});
  try {
    const local = await native.inspectApk();
    if (local && isLocalCurrent(local, release)) {
      pushLog('本地安装包已是最新版本，跳过下载');
      setState({phase: 'ready', message: `v${release.version} 已下载，可安装`, progress: 1, partial: null});
      return;
    }
    if (local) {
      pushLog('删除不是最新版本的本地安装包');
      await native.deleteApk().catch(() => {});
    }
    /** 原生侧会带 Range/If-Range 从断点继续；服务器不支持时自动从头下 */
    const partial = await native.inspectPartial().catch(() => null);
    if (partial && partial.received > 0) pushLog(`从 ${formatSize(partial.received)} 处继续下载`);
    setState({
      phase: 'downloading',
      message: `正在下载 v${release.version}`,
      progress: Math.max(0, partialRatio(partial)),
      partial,
    });
    /**
     * 整个下载流程（含断线自动续传）都在前台服务下跑：切后台、息屏都不会被系统掐断连接；
     * 原生侧起不了前台服务也只是没有保活，不能因此让下载失败。
     */
    await native.startDownloadKeepAlive().catch(() => {});
    try {
      await downloadRelease(native, release);
    } finally {
      await native.stopDownloadKeepAlive().catch(() => {});
    }
    setState({phase: 'ready', message: `v${release.version} 下载完成，等待安装`, progress: 1, partial: null});
  } catch (error) {
    pushLog(`失败：${messageOf(error)}`);
    /** 半截文件还在就退回可续传状态，用户再点一次直接接着下 */
    const partial = await native.inspectPartial().catch(() => null);
    if (partial && partial.received > 0) {
      setState({
        phase: 'available',
        message: `下载中断（已下载 ${formatSize(partial.received)}），可继续下载`,
        progress: Math.max(0, partialRatio(partial)),
        partial,
      });
    } else {
      setState({phase: 'error', message: `下载失败：${messageOf(error)}`, progress: 0, partial: null});
    }
  }
}

/**
 * 只拉起系统安装器：缺少「安装未知应用」权限时返回 permission，由 JS 引导去设置。
 * 用户在授权页返回后可以再调一次，不用重跑停止容器那一套。
 */
export async function launchInstaller(): Promise<InstallResult> {
  if (!native) {
    setState({message: 'KarinUpdater 原生模块不可用，请重新编译安装应用'});
    return 'failed';
  }
  try {
    const result = await native.installApk();
    if (result === 'launched') {
      pushLog('安装器已启动，安装完成后重新打开应用即可');
      setState({message: '已拉起系统安装器，请按提示完成安装'});
    } else {
      pushLog('缺少「安装未知应用」权限');
      setState({message: '需要授予「安装未知应用」权限'});
    }
    return result;
  } catch (error) {
    pushLog(`安装失败：${messageOf(error)}`);
    setState({message: `安装失败：${messageOf(error)}`});
    return 'failed';
  }
}

/** 安装已下载的更新：先优雅停止 proot 容器（QUIT 后超时强杀），再拉起系统安装器。 */
export async function installDownloadedUpdate(): Promise<InstallResult> {
  if (native) {
    try {
      pushLog('正在停止 Karin…');
      await karinService.stop().catch(() => {});
      pushLog('正在让 proot 容器优雅退出（超时后强杀）…');
      await prootController.stop(false).catch(() => {});
      pushLog('容器已退出，拉起系统安装器');
    } catch (error) {
      pushLog(`停止容器失败：${messageOf(error)}`);
    }
  }
  return launchInstaller();
}

export async function openInstallPermission(): Promise<boolean> {
  if (!native) return false;
  return native.openInstallPermissionSettings().catch(() => false);
}

/** 读取当前 App 版本，用于设置页展示与版本比较。 */
export async function refreshAppInfo(): Promise<void> {
  if (!native) return;
  try {
    const info = await native.getAppInfo();
    setState({appVersion: info.versionName});
  } catch {
    // 原生不可用时保持空版本号，检查更新会给出提示
  }
}

/**
 * 启动时清理安装包：已下载 APK 的 versionCode 不大于当前 App 版本，
 * 说明已经装上了（或被更高版本取代），直接删除；否则留着下次直接安装。
 */
export async function cleanupDownloadedApk(): Promise<void> {
  if (!native) return;
  try {
    const [info, apk] = await Promise.all([native.getAppInfo(), native.inspectApk()]);
    setState({appVersion: info.versionName});
    if (apk && apk.versionCode > 0 && apk.versionCode <= info.versionCode) await native.deleteApk();
  } catch {
    // 清理失败不影响启动
  }
}
