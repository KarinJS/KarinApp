import {executeAndCollect, executeStreaming} from './prootController';
import {proxiedUrl} from './appSettings';
import {fetchPackageVersions} from './packageVersions';
import {KARIN_DIR, Plugin, pluginInstallPath, pnpmCommand} from './pluginService';
import {shellQuote} from '../utils/shell';

export type PluginVersionEntry = {
  /** 切换时回传给 switchPluginVersion 的值：npm 是版本号，git 是完整提交哈希 */
  value: string;
  label: string;
  description?: string;
};

export type PluginVersionList = {
  /** 已安装的版本（npm）或 HEAD 提交（git），读不到时为空字符串 */
  current: string;
  versions: PluginVersionEntry[];
  /** 远程读不到时说明为什么只剩本地历史 */
  warning?: string;
};

/** npm 只接受具体版本号：范围、dist-tag 和命令注入都会把包名拼坏 */
const NPM_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][\w.]+)*$/;
/** git 只接受完整哈希：短哈希在浅克隆仓库里可能有歧义，分支名也不该被当成提交切换 */
const GIT_COMMIT_RE = /^[a-f0-9]{40}$/i;

const GIT_LOG_LIMIT = 100;
const READ_TIMEOUT_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5 * 60 * 1000;
const SWITCH_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 版本切换只对确认来源的已安装插件开放：npm 插件得在 node_modules 里，
 * git 插件得是从仓库克隆进 plugins/ 的目录。未知来源（ZIP / 手动导入 /
 * 直链下载）和 app 插件不给换，否则会把用户自己的文件换没。
 */
export const canSwitchPluginVersion = (plugin: Plugin) => {
  if (!plugin.installed || plugin.virtual) return false;
  if (plugin.type === 'npm') return plugin.installSource === undefined || plugin.installSource === 'npm';
  if (plugin.type === 'git') return plugin.installSource === 'git';
  return false;
};

const assertSwitchable = (plugin: Plugin) => {
  if (!canSwitchPluginVersion(plugin)) throw new Error(`${plugin.name} 的安装来源未知，不支持切换版本`);
};

const gitIn = (path: string) => `git -C ${shellQuote(path)}`;

/**
 * 插件目录必须自带 .git。容器里有别的 git 仓库（比如 karin 本体）时，
 * 直接跑 git 会向上找到父仓库，把父仓库的历史和 HEAD 当成插件的。
 */
const assertGitRepository = async (path: string) => {
  const command = `if test -d ${shellQuote(`${path}/.git`)} || test -f ${shellQuote(`${path}/.git`)}; then echo yes; else echo no; fi`;
  const output = await executeAndCollect(command, READ_TIMEOUT_MS);
  if (output.trim() !== 'yes') throw new Error(`${path} 不是 git 仓库（缺少 .git），不能切换版本`);
};

/** 已安装的 npm 版本：以 node_modules 里那份 package.json 为准，读不到返回空 */
const readInstalledNpmVersion = async (plugin: Plugin) => {
  const path = pluginInstallPath(plugin);
  try {
    const output = await executeAndCollect(`cat ${shellQuote(`${path}/package.json`)} 2>/dev/null || true`, READ_TIMEOUT_MS);
    const parsed: unknown = JSON.parse(output.trim() || '{}');
    const version = (parsed as {version?: unknown})?.version;
    return typeof version === 'string' ? version.trim() : '';
  } catch {
    return '';
  }
};

/** 依赖写在 package.json 的哪个分组里：devDependencies 走 -D、optionalDependencies 走 -O，否则会被挪进 dependencies */
const readDependencyLocation = async (name: string) => {
  const output = await executeAndCollect(`cat ${shellQuote(`${KARIN_DIR}/package.json`)} 2>/dev/null || true`, READ_TIMEOUT_MS);
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(output.trim() || '{}') as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const locations = ['devDependencies', 'optionalDependencies', 'dependencies'] as const;
  return locations.find(location => {
    const section = manifest?.[location];
    return Boolean(section) && typeof section === 'object' && name in (section as Record<string, unknown>);
  });
};

const fetchNpmVersionList = async (plugin: Plugin, force: boolean): Promise<PluginVersionList> => {
  const [versions, current] = await Promise.all([
    fetchPackageVersions(plugin.name, {force}),
    readInstalledNpmVersion(plugin),
  ]);
  return {
    current,
    versions: versions.map(version => ({value: version, label: version})),
    warning: current && !versions.includes(current) ? `本地安装的是 ${current}，npm 上已经没有这个版本了。` : undefined,
  };
};

const readGitLog = async (git: string): Promise<PluginVersionEntry[]> => {
  const command = [
    `${git} log -n ${GIT_LOG_LIMIT}`,
    `--date=${shellQuote('format:%Y-%m-%d %H:%M')}`,
    `--pretty=${shellQuote('format:%H%x1f%s%x1f%an%x1f%ad')}`,
    '2>/dev/null || true',
  ].join(' ');
  const output = await executeAndCollect(command, READ_TIMEOUT_MS);
  return output.split('\n').flatMap(line => {
    const [hash = '', subject = '', author = '', date = ''] = line.trim().split('\x1f');
    if (!GIT_COMMIT_RE.test(hash)) return [];
    const description = [author.trim(), date.trim()].filter(Boolean).join(' · ');
    return [{value: hash, label: subject.trim() || '（无提交说明）', description: description || undefined}];
  });
};

/**
 * 补齐历史：浅克隆只有最后一次提交，要换版本就得先把仓库补全。
 * 远程读不到不算失败——本地已有的提交照样能看能切，只提示一句。
 */
const refreshGitHistory = async (git: string): Promise<string | undefined> => {
  const remote = (await executeAndCollect(`${git} config --get remote.origin.url 2>/dev/null || true`, READ_TIMEOUT_MS)).trim();
  if (!remote) return '插件目录没有配置远程仓库，只显示本地已有的提交。';
  /** GitHub 加速跟着 origin 走，后面的 fetch 才会带上加速前缀 */
  const proxied = proxiedUrl(remote);
  if (proxied !== remote) {
    await executeAndCollect(`${git} remote set-url origin ${shellQuote(proxied)}`, READ_TIMEOUT_MS).catch(() => '');
  }
  const shallowCommand = `${git} rev-parse --is-shallow-repository 2>/dev/null || echo false`;
  const shallow = (await executeAndCollect(shallowCommand, READ_TIMEOUT_MS)).trim() === 'true';
  try {
    await executeAndCollect(`${git} fetch ${shallow ? '--unshallow ' : ''}--prune origin`, FETCH_TIMEOUT_MS);
    return undefined;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 160);
    return `远程仓库读取失败，只显示本地已有的提交（${message}）`;
  }
};

const fetchGitVersionList = async (plugin: Plugin): Promise<PluginVersionList> => {
  const path = pluginInstallPath(plugin);
  const git = gitIn(path);
  await assertGitRepository(path);
  const current = (await executeAndCollect(`${git} rev-parse HEAD`, READ_TIMEOUT_MS)).trim();
  const warning = await refreshGitHistory(git);
  return {current, versions: await readGitLog(git), warning};
};

/**
 * 可切换的版本列表：npm 读 registry 的发布版本，git 读仓库提交历史。
 * 两边都先确认插件来源，未知来源直接抛错（UI 也不会显示切换按钮）。
 */
export async function fetchPluginVersionList(plugin: Plugin, options: {force?: boolean} = {}): Promise<PluginVersionList> {
  assertSwitchable(plugin);
  return plugin.type === 'git' ? fetchGitVersionList(plugin) : fetchNpmVersionList(plugin, options.force === true);
}

const switchNpmVersion = async (
  plugin: Plugin,
  version: string,
  onLog: (line: string) => void,
  signal?: AbortSignal,
) => {
  const target = version.trim();
  if (!NPM_VERSION_RE.test(target)) throw new Error('请选择具体的版本号');
  const location = await readDependencyLocation(plugin.name);
  /** 依赖在 package.json 里的分组必须保留：不带 -D/-O 的 pnpm i 会把包挪进 dependencies */
  const flag = location === 'devDependencies' ? '-D ' : location === 'optionalDependencies' ? '-O ' : '';
  onLog(`${plugin.name} → ${target}`);
  const command = pnpmCommand(`i ${flag}${shellQuote(`${plugin.name}@${target}`)} --save-exact`);
  return executeStreaming(command, onLog, SWITCH_TIMEOUT_MS, signal);
};

const switchGitVersion = async (
  plugin: Plugin,
  version: string,
  onLog: (line: string) => void,
  signal?: AbortSignal,
) => {
  const target = version.trim().toLowerCase();
  if (!GIT_COMMIT_RE.test(target)) throw new Error('请选择要切换的提交');
  const path = pluginInstallPath(plugin);
  const git = gitIn(path);
  await assertGitRepository(path);
  /** 只看已跟踪文件的改动：插件目录里的 node_modules 等未跟踪文件不该拦住切换 */
  const dirty = (await executeAndCollect(`${git} status --porcelain --untracked-files=no`, READ_TIMEOUT_MS)).trim();
  if (dirty) {
    const preview = dirty.split('\n').slice(0, 5).join('\n');
    throw new Error(`插件目录有未提交的改动，请先提交或撤销后再切换：\n${preview}`);
  }
  onLog(`${plugin.name} → 提交 ${target.slice(0, 8)}`);
  await executeStreaming(`${git} checkout --detach ${shellQuote(target)}`, onLog, SWITCH_TIMEOUT_MS, signal);
  /** 换提交后按新那份 package.json 重装依赖，和安装时的收尾保持一致 */
  const install = `if test -f ${shellQuote(`${path}/package.json`)}; then cd ${shellQuote(path)} && pnpm i; fi`;
  await executeStreaming(install, onLog, SWITCH_TIMEOUT_MS, signal);
};

/**
 * 切换已安装插件的版本：npm 用 pnpm 装指定版本（保留原依赖分组），
 * git 检出目标提交后重装依赖。两者都会改容器里的文件，只由插件任务调用。
 */
export async function switchPluginVersion(
  plugin: Plugin,
  version: string,
  onLog: (line: string) => void,
  signal?: AbortSignal,
) {
  assertSwitchable(plugin);
  if (!version.trim()) throw new Error('请选择要切换的版本');
  return plugin.type === 'git'
    ? switchGitVersion(plugin, version, onLog, signal)
    : switchNpmVersion(plugin, version, onLog, signal);
}
