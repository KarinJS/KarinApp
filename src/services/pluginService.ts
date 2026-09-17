import {executeAndCollect, executeStreaming} from './prootController';
import {proxiedUrl} from './appSettings';
import {shellQuote} from '../utils/shell';
import {gitService} from './gitService';

export type PluginType = 'npm' | 'git' | 'app';
export type PluginInstallSource = 'npm' | 'git' | 'local';

type PluginRepository = {
  type?: string;
  url?: string;
  branch?: string;
};

export type PluginFile = {
  name?: string;
  description?: string;
  url?: string;
};

export type Plugin = {
  name: string;
  type: PluginType;
  description?: string;
  homepage?: string;
  version?: string;
  installed?: boolean;
  /** 实际安装来源：plugins 下没有 .git 的目录（例如 ZIP 导入）为 local。 */
  installSource?: PluginInstallSource;
  repo?: PluginRepository[];
  files?: PluginFile[];
  allowBuild?: string[];
  /** 插件市场给的分类标签，市场后续新增分类时会原样带过来 */
  categories?: string[];
  /**
   * app 插件的已安装文件名（on-disk 名称，可能被用户改过名，靠哈希匹配得到）。
   * 目录条目 karin-plugin-example 里则是目录下的全部文件。
   */
  installedFiles?: string[];
  /** 虚拟条目：karin-plugin-example 目录本身，只能卸载，不能安装 */
  virtual?: boolean;
  /** 本地探测到、插件市场列表里没有的条目；安装来源单独由 installSource 表示。 */
  local?: boolean;
};

/** 同名的 npm 包和 plugins 目录是两份安装，列表和任务都按实际位置区分。 */
export const pluginIdentity = (plugin: Plugin) =>
  `${plugin.type === 'git' ? 'directory' : plugin.type}:${plugin.name}`;

export type PluginDetails = {
  readme: string;
  githubUrl?: string;
  npmUrl: string;
};

/** karin-plugin-example 目录里的实际文件 */
type AppPluginFileState = {
  name: string;
  hash: string;
  /** 通过哈希匹配出的归属插件名，匹配不到就是外来文件 */
  owner?: string;
};

export type PluginSnapshot = {
  plugins: Plugin[];
  appDirFiles: AppPluginFileState[];
};

type InstallOptions = {
  /** app 插件：只安装选中的文件 */
  files?: PluginFile[];
  /** app 插件：同名冲突时换个文件名落地，key 是原文件名 */
  renames?: Record<string, string>;
  /** 未知来源文件（手动导入的）：不写归属记账，卸载列表里永远显示为未知来源 */
  thirdParty?: boolean;
  /** git 目标目录已有内容时请求用户确认覆盖。 */
  onWarning?: (warning: {title?: string; message: string; confirmLabel?: string; cancelLabel?: string}) => Promise<boolean>;
};

type RemoveOptions = {
  /** 指定要删除的文件名，用于 karin-plugin-example 目录条目 */
  appFiles?: string[];
};

export const npmPackageUrl = (name: string) => `https://www.npmjs.com/package/${name}`;

export const KARIN_DIR = '/root/karin';
const PLUGIN_TYPES = new Set<PluginType>(['npm', 'git', 'app']);

/**
 * npm 上 Karin 插件的命名约定：
 * karin-plugin-xxx（标准）、@karinjs/plugin-xxx（官方）、@scope/karin-plugin-xxx（组织包）。
 * 本地探测和依赖管理都靠它判断一个包算不算插件。
 */
const PLUGIN_PACKAGE_RES = [/^karin-plugin-[\w.-]+$/i, /^@[^/]+\/karin-plugin-[\w.-]+$/i, /^@karinjs\/plugin-[\w.-]+$/i];

/** 包名是不是 Karin 插件 */
export const isPluginPackageName = (name: string) => PLUGIN_PACKAGE_RES.some(pattern => pattern.test(name));

/** 依赖名（可带 @version 后缀）：pkg、@scope/pkg、pkg@1.0.0 都算合法 */
const DEPENDENCY_NAME_RE = /^(?:@[\w.-]+\/)?[\w.-]+(?:@[\w.^~><=*|-]+)?$/;

/**
 * 依赖的版本部分：版本号、^ / ~ / x 范围、dist-tag（latest、next）。
 * github:/link:/workspace: 这类地址不是版本，容器内换版本会把它变成 npm 包，直接拒掉。
 */
const DEPENDENCY_SPEC_RE = /^[\w.*^~+-]+$/;

/**
 * Karin 约定：所有 app 类型插件的 .js 文件都放在这个目录，Karin 启动时按文件加载。
 * 所以 app 插件只能按文件维度管理，不能按插件名建目录。
 */
export const APP_PLUGIN_DIR = 'karin-plugin-example';

/** app 插件目录在 rootfs 里的相对路径（容器内 /root/karin/... 去掉开头的 /），原生复制本地文件时用 */
export const APP_PLUGIN_ROOTFS_DIR = `${KARIN_DIR.replace(/^\//, '')}/plugins/${APP_PLUGIN_DIR}`;

/** 记录每个 app 插件装了哪些文件（文件名 + sha256），用于改过名也能认出来 */
const APP_MANIFEST_PATH = `${KARIN_DIR}/.karin-app-plugins.json`;

type AppManifestEntry = {file: string; hash: string};
type AppManifest = Record<string, AppManifestEntry[]>;

/** 预留分类：把市场里可能出现的中英文写法归一到同一个分组，未收录的标签原样保留 */
const CATEGORY_ALIASES: Record<string, string> = {
  official: 'official',
  karin: 'official',
  官方: 'official',
  官方插件: 'official',
  tool: 'tool',
  tools: 'tool',
  util: 'tool',
  utils: 'tool',
  工具: 'tool',
  实用工具: 'tool',
  adapter: 'adapter',
  adapters: 'adapter',
  适配器: 'adapter',
  fun: 'fun',
  娱乐: 'fun',
  游戏: 'fun',
};

const normalizeCategory = (value: string) => {
  const label = value.trim();
  if (!label) return '';
  return CATEGORY_ALIASES[label] ?? CATEGORY_ALIASES[label.toLowerCase()] ?? label.toLowerCase();
};

const readCategories = (item: any): string[] => {
  const raw = item.category ?? item.categories ?? item.tags;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，、\s]+/) : [];
  const categories = list
    .filter((value: unknown): value is string => typeof value === 'string')
    .map(normalizeCategory)
    .filter(Boolean);
  return Array.from(new Set(categories));
};

/** 官方插件：市场标了 official，或者包名/仓库属于 KarinJS 官方 */
const isOfficialPlugin = (plugin: Plugin) => {
  if (plugin.categories?.includes('official')) return true;
  if (/^@karinjs\//i.test(plugin.name)) return true;
  const urls = [plugin.homepage, ...(plugin.repo ?? []).map(repository => repository.url)];
  return urls.some(url => typeof url === 'string' && /github\.com\/karinjs\//i.test(url));
};

/** 插件归属的分类 id，用于列表筛选 */
export const pluginCategoryIds = (plugin: Plugin) => {
  const ids = [...(plugin.categories ?? [])];
  if (plugin.virtual) return ids;
  if (isOfficialPlugin(plugin) && !ids.includes('official')) ids.unshift('official');
  return ids;
};

const pluginPath = (plugin: Plugin) => {
  const segments = plugin.name.split('/');
  const validName =
    /^(?:@[\w.-]+\/)?[\w.-]+$/.test(plugin.name) &&
    segments.every(segment => segment !== '.' && segment !== '..' && segment.replace(/^@/, '') !== '..');
  if (!validName) {
    throw new Error(`插件名称不合法：${plugin.name}`);
  }
  return `${KARIN_DIR}/plugins/${plugin.name}`;
};

/** app 插件共享的目录 */
const appPluginPath = () => `${KARIN_DIR}/plugins/${APP_PLUGIN_DIR}`;

let cache: Plugin[] | null = null;
const detailCache = new Map<string, PluginDetails>();

const PLUGIN_LIST_URL = 'https://registry.npmjs.org/@karinjs/plugins-list/latest';
async function fetchPlugins(force = false): Promise<Plugin[]> {
  if (cache && !force) return cache;
  let raw: any;
  try {
    raw = await fetch(PLUGIN_LIST_URL).then(response => {
      if (!response.ok) throw new Error(`插件列表请求失败 (${response.status})`);
      return response.json();
    });
  } catch (error) {
    /** 刷新失败时退回上次拿到的市场列表：至少本地装的插件还能看见 */
    if (cache) return cache;
    throw error;
  }
  const source = Array.isArray(raw) ? raw : raw.plugins ?? raw.list ?? raw.data ?? [];
  if (!Array.isArray(source)) throw new Error('插件列表格式错误');
  cache = source
    .map((item: any): Plugin => ({
      name: item.name ?? item.package ?? item.id,
      type: item.type as PluginType,
      description: item.description ?? item.desc,
      homepage: item.home ?? item.homepage ?? item.url,
      version: item.version,
      repo: Array.isArray(item.repo) ? item.repo : undefined,
      files: Array.isArray(item.files) ? item.files : undefined,
      allowBuild: Array.isArray(item.allowBuild) ? item.allowBuild : undefined,
      categories: readCategories(item),
    }))
    .filter(item => typeof item.name === 'string' && item.name && PLUGIN_TYPES.has(item.type));
  return cache;
}

const isSafeFileName = (name: string) =>
  Boolean(name) && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..';

const appFileName = (url: string) => {
  const parsed = new URL(url);
  const fileName = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
  if (!isSafeFileName(fileName)) {
    throw new Error(`App 插件文件地址不合法：${url}`);
  }
  return fileName;
};

/** app 插件文件按 URL 落地时的文件名 */
export const appPluginFileName = (url: string) => appFileName(url);

/** 从直链推文件名；推不出来（比如地址以 / 结尾）返回空串 */
export const appPluginNameFromUrl = (url: string) => {
  try {
    return appFileName(url.trim());
  } catch {
    return '';
  }
};

/**
 * 手动安装：市场列表里没有这个 app 插件文件时，用户自己填直链和文件名。
 * 下载、同名冲突、哈希记账都复用市场那套流程，这里只现造一个单文件条目。
 */
export const manualAppPlugin = (url: string, fileName = '') => {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('请填写以 http:// 或 https:// 开头的直链');
  const derived = appPluginNameFromUrl(trimmed);
  const wanted = (fileName.trim() || derived).trim();
  if (!wanted) throw new Error('请填写文件名，例如 my-plugin.js');
  const target = wanted.toLowerCase().endsWith('.js') ? wanted : `${wanted}.js`;
  if (!isSafeFileName(target)) throw new Error(`文件名不合法：${target}`);
  const files: PluginFile[] = [{name: '手动安装', description: '来自手动填写的直链', url: trimmed}];
  return {
    plugin: {
      name: target,
      type: 'app' as PluginType,
      description: '手动安装的 APP 插件',
      files,
    },
    files,
    renames: target === derived ? undefined : {[derived || '*']: target},
  };
};

/** 从 git 地址推目录名：https://github.com/a/karin-plugin-x.git → karin-plugin-x */
export const gitPluginNameFromUrl = (url: string) => {
  const trimmed = url.trim().replace(/\/+$/, '');
  const tail = trimmed.split(/[/:]/).pop() ?? '';
  return tail.replace(/\.git$/i, '').trim();
};

/**
 * 手动安装 git 插件：市场列表里没有的仓库，用户自己填地址（可选分支、目录名）。
 * 安装 / 更新 / 卸载都复用市场那套 git 流程，这里只现造一个 git 条目。
 */
/** 只接受 Git 分支/ref 名称，不接受选项和 revision 表达式。 */
const validateGitRef = (value: string, label: string) => {
  if (!value) return;
  const invalid = value.startsWith('-') || value.startsWith('/') || value.endsWith('/') ||
    value.endsWith('.') || value.includes('..') || value.includes('@{') ||
    value.includes('//') || /[\s~^:?*[\\]/.test(value) ||
    Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'));
  if (invalid) throw new Error(`${label} 不合法：${value}`);
};

export const manualGitPlugin = (url: string, name = '', branch = '') => {
  const trimmed = url.trim();
  if (!/^(?:https?:\/\/|git:\/\/|ssh:\/\/|git@)/i.test(trimmed)) {
    throw new Error('请填写 git 仓库地址（https://… 或 git@…）');
  }
  const wanted = (name.trim() || gitPluginNameFromUrl(trimmed)).trim();
  if (!wanted) throw new Error('请填写插件目录名，例如 karin-plugin-xxx');
  validateGitRef(branch.trim(), '分支');
  /** karin-plugin-example 是 app 插件共享目录，git 覆盖安装会 rm -rf 掉里面的文件 */
  if (wanted === APP_PLUGIN_DIR) throw new Error(`${APP_PLUGIN_DIR} 是 APP 插件目录，不能作为 git 插件目录名`);
  const plugin: Plugin = {
    name: wanted,
    type: 'git',
    description: '手动安装的 Git 插件',
    homepage: githubUrlFrom(trimmed),
    repo: [{
      type: 'git',
      url: trimmed,
      branch: branch.trim() || undefined,
    }],
  };
  /** 复用市场那套名称校验，名字不合法直接抛错 */
  pluginPath(plugin);
  return plugin;
};

/** 插件在容器里的安装位置（详情页、依赖管理里展示用） */
export const pluginInstallPath = (plugin: Plugin) =>
  plugin.type === 'npm' ? `${KARIN_DIR}/node_modules/${plugin.name}` : pluginPath(plugin);

/** app 插件的文件列表（过滤掉没有直链的项） */
export const appPluginFiles = (plugin: Plugin) =>
  (plugin.files ?? []).filter((file): file is PluginFile & {url: string} => typeof file.url === 'string' && Boolean(file.url));

type DirFile = {name: string; hash: string};

/** 列出 karin-plugin-example 里的文件及其 sha256 */
const listAppPluginDir = async (): Promise<DirFile[]> => {
  try {
    const output = await executeAndCollect(`cd ${shellQuote(appPluginPath())} 2>/dev/null && sha256sum * 2>/dev/null; true`);
    return output
      .split('\n')
      .map(line => line.trim())
      .flatMap(line => {
        const matched = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
        if (!matched) return [];
        const name = matched[2].replace(/^\\/, '').trim();
        return name ? [{name, hash: matched[1].toLowerCase()}] : [];
      });
  } catch {
    return [];
  }
};

const readAppManifest = async (): Promise<AppManifest> => {
  try {
    const output = await executeAndCollect(`cat ${shellQuote(APP_MANIFEST_PATH)} 2>/dev/null || true`);
    const parsed = JSON.parse(output.trim() || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const manifest: AppManifest = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([name, value]) => {
      if (!Array.isArray(value)) return;
      const entries = value.filter((item): item is AppManifestEntry =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as AppManifestEntry).file === 'string' &&
        typeof (item as AppManifestEntry).hash === 'string');
      if (entries.length) manifest[name] = entries;
    });
    return manifest;
  } catch {
    return {};
  }
};

const writeAppManifest = async (manifest: AppManifest) => {
  const payload = JSON.stringify(manifest);
  await executeAndCollect(
    `mkdir -p ${shellQuote(KARIN_DIR)} && printf '%s' ${shellQuote(payload)} > ${shellQuote(APP_MANIFEST_PATH)}`,
  ).catch(() => {});
};

// APP 下载可以并行；归属文件的读取、修改和写回必须完整串行，避免相互覆盖。
let appManifestQueue = Promise.resolve();
const withAppManifest = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = appManifestQueue.then(operation);
  appManifestQueue = result.then(() => {}, () => {});
  return result;
};

/** 安装完成后记录文件哈希，之后即使改名也能认出这个 js 属于哪个 app 插件 */
const recordAppInstall = (plugin: Plugin, fileNames: string[]) => withAppManifest(async () => {
  if (!fileNames.length) return;
  const [dirFiles, manifest] = await Promise.all([listAppPluginDir(), readAppManifest()]);
  const entries = fileNames.flatMap(name => {
    const file = dirFiles.find(item => item.name === name);
    return file ? [{file: file.name, hash: file.hash}] : [];
  });
  if (!entries.length) return;
  const replaced = entries.map(entry => entry.file);
  Object.keys(manifest).forEach(key => {
    if (key === plugin.name) return;
    manifest[key] = manifest[key].filter(entry => !replaced.includes(entry.file));
    if (!manifest[key].length) delete manifest[key];
  });
  manifest[plugin.name] = [
    ...(manifest[plugin.name] ?? []).filter(entry => !replaced.includes(entry.file)),
    ...entries,
  ];
  await writeAppManifest(manifest);
});

/** 快照清理与安装记账共用队列，避免旧快照擦掉刚安装的插件归属。 */
const readAppPluginState = () => withAppManifest(async () => {
  const [dirFiles, manifest] = await Promise.all([listAppPluginDir(), readAppManifest()]);
  const filesByHash = new Map<string, DirFile[]>();
  dirFiles.forEach(file => {
    const bucket = filesByHash.get(file.hash) ?? [];
    bucket.push(file);
    filesByHash.set(file.hash, bucket);
  });
  const owners = new Map<string, string>();
  const matches = new Map<string, string[]>();
  const nextManifest: AppManifest = {};
  Object.keys(manifest).forEach(pluginName => {
    const used = new Set<string>();
    const kept: AppManifestEntry[] = [];
    const matched: string[] = [];
    manifest[pluginName].forEach(entry => {
      const candidates = filesByHash.get(entry.hash) ?? [];
      const hit =
        candidates.find(candidate => candidate.name === entry.file && !used.has(candidate.name)) ??
        candidates.find(candidate => !used.has(candidate.name));
      if (!hit) return;
      used.add(hit.name);
      matched.push(hit.name);
      kept.push({file: hit.name, hash: hit.hash});
      if (!owners.has(hit.name)) owners.set(hit.name, pluginName);
    });
    if (kept.length) nextManifest[pluginName] = kept;
    matches.set(pluginName, matched);
  });
  if (JSON.stringify(nextManifest) !== JSON.stringify(manifest)) {
    await writeAppManifest(nextManifest);
  }
  return {dirFiles, owners, matches};
});

/** 目录条目：karin-plugin-example 本身，只能卸载 */
export const appPluginDirEntry = (snapshot: PluginSnapshot): Plugin => ({
  name: APP_PLUGIN_DIR,
  type: 'app',
  virtual: true,
  description: 'APP 插件目录，所有 app 类型的 .js 文件都放在这里',
  installed: snapshot.appDirFiles.length > 0,
  installedFiles: snapshot.appDirFiles.map(file => file.name),
});

/** 一次性探测所有目录型插件，避免每个插件都跑一次命令 */
const pluginProbe = (plugin: Plugin) => {
  const identity = pluginIdentity(plugin);
  try {
    const path = plugin.type === 'npm' ? `${KARIN_DIR}/node_modules/${plugin.name}` : pluginPath(plugin);
    const check = plugin.type === 'git'
      ? `test -d ${shellQuote(path)} && test -f ${shellQuote(`${path}/package.json`)}`
      : `test -e ${shellQuote(path)}`;
    return {name: identity, command: `${check} && echo ${shellQuote(identity)}`};
  } catch {
    return {name: identity, command: 'false'};
  }
};

const listExistingPlugins = async (probes: {name: string; command: string}[]) => {
  if (!probes.length) return new Set<string>();
  try {
    const output = await executeAndCollect(`${probes.map(probe => probe.command).join('; ')}; true`);
    return new Set(output.split('\n').map(line => line.trim()).filter(Boolean));
  } catch {
    return new Set<string>();
  }
};

type LocalPlugin = {
  name: string;
  type: 'npm' | 'git';
  installSource: PluginInstallSource;
  /** git 插件的来源仓库（从 .git 配置里读，读不到就空） */
  remote?: string;
};

/**
 * 一次扫描容器里已装的插件：npm 的看 node_modules（三种命名约定），目录插件看 plugins/。
 * 不是从插件市场装进来的也照样能探到，这样本地装的插件在列表里看得见、也能卸载。
 */
const scanLocalPlugins = async (): Promise<LocalPlugin[]> => {
  const nodeModules = `${KARIN_DIR}/node_modules`;
  const pluginsDir = `${KARIN_DIR}/plugins`;
  // do 后必须换行，不能用分号连接成 do;，否则整个本地扫描命令都会语法错误。
  const listGitDirs = [
    `for d in ${pluginsDir}/*/ ${pluginsDir}/@*/*/; do`,
    `test -d "$d" || continue`,
    `r=''`,
    `s=local`,
    `if test -d "$d/.git" || test -f "$d/.git"; then`,
    `s=git`,
    `fi`,
    `printf '%s\t%s\t%s\n' "$d" "$r" "$s"`,
    `done`,
  ].join('\n');
  const command = [
    `echo '@npm'`,
    `ls -d ${nodeModules}/karin-plugin-* ${nodeModules}/@*/karin-plugin-* ${nodeModules}/@karinjs/plugin-* 2>/dev/null`,
    `echo '@git'`,
    listGitDirs,
    'true',
  ].join('; ');

  const [output, repositories] = await Promise.all([
    executeAndCollect(command).catch(() => ''),
    gitService.listRepositories().catch(() => []),
  ]);

  const npmPrefix = `${nodeModules}/`;
  const pluginsPrefix = `${pluginsDir}/`;
  const found = new Map<string, LocalPlugin>();
  let section = '';
  output.split('\n').forEach(raw => {
    const line = raw.trim();
    if (line === '@npm' || line === '@git') {
      section = line === '@npm' ? 'npm' : 'git';
      return;
    }
    if (!line) return;
    if (section === 'npm' && line.startsWith(npmPrefix)) {
      const name = line.slice(npmPrefix.length).replace(/\/+$/, '');
      if (name) found.set(`npm:${name}`, {name, type: 'npm', installSource: 'npm'});
      return;
    }
    if (section === 'git') {
      const [rawDir, remote = '', source = 'local'] = line.split('\t');
      const path = (rawDir ?? '').trim();
      if (!path.startsWith(pluginsPrefix)) return;
      const name = path.slice(pluginsPrefix.length).replace(/\/+$/, '').trim();
      /** app 共用目录和 @scope 分组目录不作为独立插件；卸载使用实际落地目录名。 */
      if (!name || name === APP_PLUGIN_DIR || /^@[^/]+$/.test(name)) return;
      try {
        pluginPath({name, type: 'git'});
      } catch {
        return;
      }
      found.set(`directory:${name}`, {
        name,
        type: 'git',
        installSource: source === 'git' ? 'git' : 'local',
        remote: remote.trim() || undefined,
      });
    }
  });
  // 原生读取 Git 仓库状态不依赖 proot；容器停机时仍显示已经克隆的插件。
  repositories.forEach(repository => {
    try {
      const name = repository.name;
      if (!name || name === APP_PLUGIN_DIR || /^@[^/]+$/.test(name)) return;
      pluginPath({name, type: 'git'});
      found.set(`directory:${name}`, {
        name,
        type: 'git',
        installSource: 'git',
        remote: repository.remote.trim() || undefined,
      });
    } catch {
      // 不接受不合法的原生路径或目录名。
    }
  });
  return [...found.values()];
};

/**
 * 拉取插件市场 + 容器内的安装状态。
 * app 插件按哈希归属判断，所以随便改个同名的文件不会被误判成该插件。
 * 本地探测按安装位置合并市场资料，同名的 npm 包、目录插件和 app 文件分别保留。
 */
export async function loadPluginSnapshot(force = false): Promise<PluginSnapshot> {
  const [market, appState, local] = await Promise.all([
    fetchPlugins(force),
    readAppPluginState(),
    scanLocalPlugins(),
  ]);
  const {dirFiles, owners, matches} = appState;
  const stored = await listExistingPlugins(market.filter(plugin => plugin.type !== 'app').map(pluginProbe));
  const marketByName = new Map<string, Plugin[]>();
  market.forEach(plugin => {
    const entries = marketByName.get(plugin.name) ?? [];
    entries.push(plugin);
    marketByName.set(plugin.name, entries);
  });
  const installedByIdentity = new Map<string, Plugin>();
  local.forEach(item => {
    const marketEntries = marketByName.get(item.name) ?? [];
    const metadata = marketEntries.find(plugin => plugin.type === item.type) ?? marketEntries[0];
    const githubUrl = item.remote ? githubUrlFrom(item.remote) : undefined;
    const plugin: Plugin = {
      ...metadata,
      name: item.name,
      type: item.type,
      description: metadata?.description,
      installed: true,
      installedFiles: undefined,
      installSource: item.installSource,
      local: metadata ? undefined : true,
      homepage: githubUrl ?? metadata?.homepage,
      repo: item.remote ? [{type: 'git', url: item.remote}] : metadata?.repo,
    };
    installedByIdentity.set(pluginIdentity(plugin), plugin);
  });
  market.forEach(plugin => {
    const identity = pluginIdentity(plugin);
    if (plugin.type === 'app') {
      const installedFiles = matches.get(plugin.name) ?? [];
      if (installedFiles.length) installedByIdentity.set(identity, {...plugin, installed: true, installedFiles});
    } else if (!installedByIdentity.has(identity) && stored.has(identity)) {
      // 扫描没返回时保留直接探测结果；没有 .git 证据的目录不声称来自 Git。
      installedByIdentity.set(identity, {
        ...plugin,
        installed: true,
        installSource: plugin.type === 'npm' ? 'npm' : 'local',
      });
    }
  });

  const installedNames = new Set([...installedByIdentity.values()].map(plugin => plugin.name));
  const plugins: Plugin[] = [];
  const added = new Set<string>();
  market.forEach(plugin => {
    const identity = pluginIdentity(plugin);
    if (added.has(identity)) return;
    const installed = installedByIdentity.get(identity);
    // 已有同名安装时只展示实际安装的几份，避免追加未安装的市场占位。
    if (!installed && installedNames.has(plugin.name)) return;
    plugins.push(installed ?? {...plugin, installed: false, installedFiles: plugin.type === 'app' ? [] : undefined});
    added.add(identity);
  });
  installedByIdentity.forEach((plugin, identity) => {
    if (added.has(identity)) return;
    plugins.push(plugin);
    added.add(identity);
  });

  return {
    plugins,
    appDirFiles: dirFiles.map(file => ({...file, owner: owners.get(file.name)})),
  };
}

type Repository = string | {url?: string} | undefined;

export const githubUrlFrom = (value?: string) => {
  if (!value) return undefined;
  const url = value
    .replace(/^git\+/, '')
    .replace(/^git:\/\/github\.com/, 'https://github.com')
    .replace(/^ssh:\/\/git@github\.com/, 'https://github.com');
  if (url.startsWith('https://github.com/')) return url.split(/[?#]/)[0].replace(/\.git$/, '');
  const shorthand = value.match(/^(?:github:|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  return shorthand ? `https://github.com/${shorthand[1]}` : undefined;
};

/** 仅从插件根目录读取说明；不存在与读取失败分开处理，空文件也算本地 README。 */
const readLocalPluginReadme = async (plugin: Plugin): Promise<string | null> => {
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = process.argv[1];
    let readme = null;
    try {
      const names = fs.readdirSync(directory).sort();
      for (const wanted of ['readme.md', 'readme.markdown', 'readme.txt', 'readme']) {
        const file = names.find(name => name.toLowerCase() === wanted && fs.statSync(path.join(directory, name)).isFile());
        if (file) {
          readme = fs.readFileSync(path.join(directory, file), 'utf8');
          break;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const chunks = readme === null ? null : [];
    if (readme !== null) {
      for (let offset = 0; offset < readme.length; offset += 4096) chunks.push(readme.slice(offset, offset + 4096));
    }
    process.stdout.write(JSON.stringify({readme: chunks}, null, 2));
  `;
  // daemon 会拆分超长行；每段单独成行，避免传输插入的换行破坏 JSON 字符串。
  const output = await executeAndCollect(`node -e ${shellQuote(script)} ${shellQuote(pluginInstallPath(plugin))}`);
  const result: {readme: string[] | null} = JSON.parse(output);
  return result.readme?.join('') ?? null;
};

export async function fetchPluginDetails(plugin: Plugin): Promise<PluginDetails> {
  const unknownSource = plugin.installSource === 'local';
  const githubUrl = plugin.repo?.map(repository => githubUrlFrom(repository.url)).find(Boolean) ?? githubUrlFrom(plugin.homepage);
  const npmUrl = unknownSource ? '' : npmPackageUrl(plugin.name);
  // 每次打开都先读本地，安装、更新或手动编辑后不会被远程缓存盖住。
  if (plugin.installed) {
    const readme = await readLocalPluginReadme(plugin);
    if (readme !== null) return {readme, githubUrl, npmUrl};
  }
  // ZIP/手动复制的目录可能与 npm 包重名，不能据此展示别人的远程 README。
  if (unknownSource) return {readme: '', githubUrl, npmUrl};

  const identity = pluginIdentity(plugin);
  const cached = detailCache.get(identity);
  if (cached) return cached;

  const response = await fetch(`https://registry.npmjs.org/${plugin.name.replace('/', '%2F')}`);
  if (!response.ok) throw new Error(`README.md 获取失败 (${response.status})`);
  const metadata: any = await response.json();
  const latestVersion = metadata?.['dist-tags']?.latest;
  const versionMetadata = metadata?.versions?.[latestVersion];
  const readme = [versionMetadata?.readme, metadata?.readme].find(
    value => typeof value === 'string' && value.trim() && value !== 'ERROR: No README data found!',
  );
  if (typeof readme !== 'string') throw new Error('README.md 获取失败');

  const repository: Repository = versionMetadata?.repository ?? metadata?.repository;
  const repositoryUrl = typeof repository === 'string' ? repository : repository?.url;
  const details: PluginDetails = {
    readme,
    githubUrl: githubUrl ?? githubUrlFrom(repositoryUrl),
    npmUrl,
  };
  detailCache.set(identity, details);
  return details;
}

/** Karin 项目里的 pnpm 命令：有 workspace 就带上 -w，否则直接跑 */
export const pnpmCommand = (args: string) =>
  `cd ${KARIN_DIR} && if test -f pnpm-workspace.yaml; then pnpm -w ${args}; else pnpm ${args}; fi`;

const npmInstallCommand = (plugin: Plugin) => pnpmCommand(`i ${shellQuote(plugin.name)}`);

const installGitPlugin = async (
  plugin: Plugin,
  onLog: (line: string) => void,
  signal: AbortSignal | undefined,
  options: InstallOptions,
) => {
  const repository = plugin.repo?.find(item => item.type !== 'npm' && item.url);
  if (!repository?.url) throw new Error('Git 插件缺少可用仓库地址');
  const path = pluginPath(plugin);
  const branch = repository.branch?.trim();
  validateGitRef(branch ?? '', '分支');
  /** 用户填了 GitHub 加速前缀时，clone/fetch 都走加速地址。 */
  const repositoryUrl = proxiedUrl(repository.url);
  if (signal?.aborted) throw new Error('任务已终止');
  const state = await gitService.pathState(path);
  if (!['missing', 'empty', 'occupied'].includes(state)) throw new Error('无法确认 Git 插件目标目录状态');
  if (state === 'occupied') {
    if (!options.onWarning) throw new Error(`${plugin.name} 已存在且不为空，请确认覆盖后重试`);
    const accepted = await options.onWarning({
      title: '插件已存在',
      message: `${plugin.name} 已存在且不为空，是否覆盖？`,
      confirmLabel: '是',
      cancelLabel: '否',
    });
    if (!accepted) throw new Error('用户取消覆盖');
  }
  if (signal?.aborted) throw new Error('任务已终止');
  if (state === 'occupied') {
    await gitService.update(repositoryUrl, path, branch, {onLog, signal});
  } else {
    await gitService.clone(repositoryUrl, path, branch, {onLog, signal});
  }
  onLog('Git 仓库已就绪，正在安装插件依赖…');
  try {
    return await executeStreaming(
      `if test -f ${shellQuote(`${path}/package.json`)}; then cd ${shellQuote(path)} && pnpm i; fi`,
      onLog,
      5 * 60 * 1000,
      signal,
      {waitForExitOnAbort: true},
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Git 仓库已克隆或更新，但插件依赖未安装完成。请确认容器运行后重试：\n${message}`);
  }
};

/** app 插件的下载计划：目标文件名可以由用户选择改名 */
const appInstallPlan = (plugin: Plugin, options: InstallOptions = {}) => {
  const files = options.files ?? plugin.files;
  const plan = appPluginFiles({...plugin, files}).flatMap(file => {
    let name = '';
    try {
      name = appFileName(file.url);
    } catch {
      name = '';
    }
    /** renames 按 URL 里的文件名索引；'*' 是手动安装直链取不到文件名时的兜底 */
    const renamed = options.renames?.[name] ?? options.renames?.['*'];
    const target = renamed?.trim() || name;
    if (!isSafeFileName(target)) {
      if (renamed) throw new Error(`目标文件名不合法：${target}`);
      return [];
    }
    return [{url: file.url, name, target, finalUrl: proxiedUrl(file.url)}];
  });
  if (!plan.length) throw new Error('App 插件缺少文件下载地址');
  return plan;
};

const appInstallCommand = (plan: {finalUrl: string; target: string}[]) => {
  const path = appPluginPath();
  const downloads = plan.map(item =>
    `curl -fL --retry 3 --retry-delay 2 -o ${shellQuote(`${path}/${item.target}`)} ${shellQuote(item.finalUrl)}`,
  );
  return [`mkdir -p ${shellQuote(path)}`, ...downloads].join(' && ');
};

/** 卸载：只删指定的文件，绝不整目录删除 */
const appRemoveCommand = (names: string[]) => {
  const path = appPluginPath();
  const safe = names.filter(isSafeFileName);
  if (!safe.length) throw new Error('没有可卸载的 APP 插件文件');
  return safe.map(name => `rm -f -- ${shellQuote(`${path}/${name}`)}`).join(' && ');
};

export const installPlugin = (
  plugin: Plugin,
  onLog: (line: string) => void,
  signal?: AbortSignal,
  options: InstallOptions = {},
) => {
  if (plugin.type === 'app') {
    const plan = appInstallPlan(plugin, options);
    return executeStreaming(appInstallCommand(plan), onLog, 5 * 60 * 1000, signal).then(async output => {
      /** 未知来源文件不记归属：卸载列表里一直显示为未知来源，不会伪装成某个市场插件 */
      if (!options.thirdParty) await recordAppInstall(plugin, plan.map(item => item.target));
      return output;
    });
  }
  if (plugin.type === 'git') return installGitPlugin(plugin, onLog, signal, options);
  return executeStreaming(npmInstallCommand(plugin), onLog, 5 * 60 * 1000, signal);
};

export const removePlugin = (
  plugin: Plugin,
  onLog: (line: string) => void,
  signal?: AbortSignal,
  options: RemoveOptions = {},
) => {
  const command =
    plugin.type === 'app'
      ? appRemoveCommand(options.appFiles ?? plugin.installedFiles ?? [])
      : plugin.type === 'npm'
        ? pnpmCommand(`remove ${shellQuote(plugin.name)}`)
        : `rm -rf -- ${shellQuote(pluginPath(plugin))}`;
  return executeStreaming(command, onLog, 5 * 60 * 1000, signal);
};

/** Karin 运行本体：依赖管理里不给卸载，避免把环境弄坏 */
const KARIN_CORE_PACKAGES = ['node-karin', 'karin', '@karinjs/node-karin'];

export const isKarinCorePackage = (name: string) => KARIN_CORE_PACKAGES.includes(name);

export type KarinDependency = {
  name: string;
  /** package.json 里声明的版本范围 */
  spec: string;
  /** node_modules 中当前实际安装的版本；读取失败时为空 */
  installedVersion?: string;
  /** npm 缓存中解析出的最新稳定版本 */
  latestVersion?: string;
  /** devDependencies 里的依赖 */
  dev?: boolean;
  /** package.json 中实际所属的依赖分组 */
  location?: 'dependencies' | 'devDependencies' | 'optionalDependencies';
  /** 是不是按 Karin 插件命名（决定它会不会出现在插件列表里） */
  plugin: boolean;
  /** Karin 运行本体 */
  core: boolean;
};

const KARIN_PACKAGE_JSON = `${KARIN_DIR}/package.json`;

/** 列出 /root/karin/package.json 里声明的依赖（Karin 本体和插件都装在这个项目里） */
export const listKarinDependencies = async (): Promise<KarinDependency[]> => {
  const output = await executeAndCollect(`cat ${shellQuote(KARIN_PACKAGE_JSON)} 2>/dev/null || true`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim() || '{}');
  } catch {
    throw new Error('package.json 解析失败，可能不是合法的 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const source = parsed as Record<string, unknown>;
  const merged = new Map<string, KarinDependency>();
  const collect = (field: 'dependencies' | 'devDependencies' | 'optionalDependencies') => {
    const entries = source[field];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return;
    Object.entries(entries as Record<string, unknown>).forEach(([name, spec]) => {
      if (merged.has(name)) return;
      merged.set(name, {
        name,
        spec: typeof spec === 'string' ? spec : '',
        dev: field === 'devDependencies' || undefined,
        location: field,
        plugin: isPluginPackageName(name),
        core: isKarinCorePackage(name),
      });
    });
  };
  collect('dependencies');
  collect('devDependencies');
  collect('optionalDependencies');
  const dependencies = [...merged.values()];
  // pnpm 在项目 node_modules 中为依赖创建软链接，直接读取其 package.json
  // 即可得到实际安装版本。单个包缺失时保留依赖项，其余包继续展示。
  await Promise.all(dependencies.map(async dependency => {
    const packageOutput = await executeAndCollect(
      `cat ${shellQuote(`${KARIN_DIR}/node_modules/${dependency.name}/package.json`)} 2>/dev/null || true`,
    );
    try {
      const packageJson = JSON.parse(packageOutput.trim() || '{}') as {version?: unknown};
      if (typeof packageJson.version === 'string' && packageJson.version.trim()) {
        dependency.installedVersion = packageJson.version.trim();
      }
    } catch {
      // node_modules 中没有可读取的 package.json 时，保留 undefined。
    }
  }));
  /** Karin 运行本体的版本必须最先看到，剩下的按字母序排 */
  return dependencies.sort((left, right) => {
    if (left.core !== right.core) return left.core ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
};

/** 安装输入（空格 / 逗号分隔，支持 name@version）→ 校验后的参数列表 */
export const parseDependencyInput = (input: string) => {
  const items = input
    .split(/[\s,，]+/)
    .map(item => item.trim())
    .filter(Boolean);
  items.forEach(item => {
    if (!DEPENDENCY_NAME_RE.test(item)) throw new Error(`依赖名不合法：${item}`);
  });
  return items;
};

/** 安装依赖（一次可以多个）：pnpm i a b@1.0.0 */
export const installKarinDependencies = async (
  names: string[],
  onLog: (line: string) => void,
  signal?: AbortSignal,
  options: {dev?: boolean; location?: 'dependencies' | 'devDependencies' | 'optionalDependencies'} = {},
) => {
  if (!names.length) throw new Error('请填写要安装的依赖');
  /** devDependencies 必须带 -D，否则 pnpm 会把包挪进 dependencies */
  const flag = options.location === 'devDependencies' || options.dev
    ? ' -D'
    : options.location === 'optionalDependencies'
      ? ' -O'
      : '';
  return executeStreaming(pnpmCommand(`i${flag} ${names.map(shellQuote).join(' ')}`), onLog, 5 * 60 * 1000, signal);
};

/** 删除现有依赖目录和锁文件后，按 package.json 重新安装全部依赖。 */
export const reinstallKarinDependencies = async (
  onLog: (line: string) => void,
  signal?: AbortSignal,
) => {
  const command = `cd ${KARIN_DIR} && rm -rf -- node_modules pnpm-lock.yaml && if test -f pnpm-workspace.yaml; then pnpm -w i; else pnpm i; fi`;
  return executeStreaming(command, onLog, 10 * 60 * 1000, signal);
};

/** 卸载依赖：pnpm remove <name>；Karin 本体不给删 */
export const removeKarinDependency = async (
  name: string,
  onLog: (line: string) => void,
  signal?: AbortSignal,
) => {
  if (isKarinCorePackage(name)) throw new Error(`${name} 是 Karin 运行本体，不能在依赖管理里卸载`);
  return executeStreaming(pnpmCommand(`remove ${shellQuote(name)}`), onLog, 5 * 60 * 1000, signal);
};

/** 版本 / 范围 / dist-tag 是否可写回 package.json */
export const isValidDependencySpec = (spec: string) => DEPENDENCY_SPEC_RE.test(spec.trim());

export type KarinDependencyChange = {
  name: string;
  /** 目标版本 / 范围，写进 package.json 的 dependencies 值 */
  spec: string;
  dev?: boolean;
  location?: 'dependencies' | 'devDependencies' | 'optionalDependencies';
};

/**
 * 按改动后的 spec 重装依赖（依赖管理里改版本）。
 * dependencies 与 devDependencies 必须分成两条 pnpm i：pnpm i <pkg> 会把包写进 dependencies，
 * devDependencies 的包只能走 -D，否则改一次版本就被挪出 dev 分组。
 */
export const updateKarinDependencySpecs = async (
  changes: KarinDependencyChange[],
  onLog: (line: string) => void,
  signal?: AbortSignal,
) => {
  const valid = changes.filter(change => change.name && change.spec);
  if (!valid.length) throw new Error('没有要修改的依赖');
  const groups = [
    {location: 'dependencies' as const, changes: valid.filter(change => (change.location ?? (change.dev ? 'devDependencies' : 'dependencies')) === 'dependencies')},
    {location: 'devDependencies' as const, changes: valid.filter(change => (change.location ?? (change.dev ? 'devDependencies' : 'dependencies')) === 'devDependencies')},
    {location: 'optionalDependencies' as const, changes: valid.filter(change => change.location === 'optionalDependencies')},
  ];
  for (const group of groups) {
    if (!group.changes.length) continue;
    await installKarinDependencies(
      group.changes.map(change => `${change.name}@${change.spec}`),
      onLog,
      signal,
      {location: group.location},
    );
  }
};
