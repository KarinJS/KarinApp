import {executeAndCollect, executeStreaming} from './prootController';
import {proxiedUrl} from './appSettings';
import {shellQuote} from '../utils/shell';

export type PluginType = 'npm' | 'git' | 'app';

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
  /** 本地探测到的条目：容器里装了，但插件市场列表里没有（未知来源） */
  local?: boolean;
};

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
};

type RemoveOptions = {
  /** 指定要删除的文件名，用于 karin-plugin-example 目录条目 */
  appFiles?: string[];
};

export const npmPackageUrl = (name: string) => `https://www.npmjs.com/package/${name}`;

const KARIN_DIR = '/root/karin';
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
export const manualGitPlugin = (url: string, name = '', branch = '') => {
  const trimmed = url.trim();
  if (!/^(?:https?:\/\/|git:\/\/|ssh:\/\/|git@)/i.test(trimmed)) {
    throw new Error('请填写 git 仓库地址（https://… 或 git@…）');
  }
  const wanted = (name.trim() || gitPluginNameFromUrl(trimmed)).trim();
  if (!wanted) throw new Error('请填写插件目录名，例如 karin-plugin-xxx');
  /** karin-plugin-example 是 app 插件共享目录，git 覆盖安装会 rm -rf 掉里面的文件 */
  if (wanted === APP_PLUGIN_DIR) throw new Error(`${APP_PLUGIN_DIR} 是 APP 插件目录，不能作为 git 插件目录名`);
  const plugin: Plugin = {
    name: wanted,
    type: 'git',
    description: '手动安装的 Git 插件',
    homepage: githubUrlFrom(trimmed),
    repo: [{type: 'git', url: trimmed, branch: branch.trim() || undefined}],
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

/** 安装完成后记录文件哈希，之后即使改名也能认出这个 js 属于哪个 app 插件 */
const recordAppInstall = async (plugin: Plugin, fileNames: string[]) => {
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
};

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
  try {
    const path = plugin.type === 'npm' ? `${KARIN_DIR}/node_modules/${plugin.name}` : pluginPath(plugin);
    const check = plugin.type === 'git'
      ? `test -d ${shellQuote(path)} && test -f ${shellQuote(`${path}/package.json`)}`
      : `test -e ${shellQuote(path)}`;
    return {name: plugin.name, command: `${check} && echo ${shellQuote(plugin.name)}`};
  } catch {
    return {name: plugin.name, command: 'false'};
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
  /** git 插件的来源仓库（从 .git 配置里读，读不到就空） */
  remote?: string;
};

/**
 * 一次扫描容器里已装的插件：npm 的看 node_modules（三种命名约定），git 的看 plugins/ 下的目录。
 * 不是从插件市场装进来的也照样能探到，这样本地装的插件在列表里看得见、也能卸载。
 */
const scanLocalPlugins = async (): Promise<LocalPlugin[]> => {
  const nodeModules = `${KARIN_DIR}/node_modules`;
  const pluginsDir = `${KARIN_DIR}/plugins`;
  const listGitDirs = [
    `for d in ${pluginsDir}/*/ ${pluginsDir}/@*/*/; do`,
    `test -d "$d" || continue`,
    `r=''`,
    `if command -v git >/dev/null 2>&1; then r=$(git -C "$d" config --get remote.origin.url 2>/dev/null); fi`,
    `printf '%s\t%s\n' "$d" "$r"`,
    `done`,
  ].join('; ');
  const command = [
    `echo '@npm'`,
    `ls -d ${nodeModules}/karin-plugin-* ${nodeModules}/@*/karin-plugin-* ${nodeModules}/@karinjs/plugin-* 2>/dev/null`,
    `echo '@git'`,
    listGitDirs,
    'true',
  ].join('; ');

  let output = '';
  try {
    output = await executeAndCollect(command);
  } catch {
    return [];
  }

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
      if (name) found.set(name, {name, type: 'npm'});
      return;
    }
    if (section === 'git') {
      const [rawDir, remote = ''] = line.split('\t');
      const path = (rawDir ?? '').trim();
      if (!path.startsWith(pluginsPrefix)) return;
      const name = path.slice(pluginsPrefix.length).replace(/\/+$/, '').trim();
      /** app 插件共用目录不是插件条目，市场外的目录都算本地 git 插件 */
      if (name && name !== APP_PLUGIN_DIR) found.set(name, {name, type: 'git', remote: remote.trim() || undefined});
    }
  });
  return [...found.values()];
};

/**
 * 拉取插件市场 + 容器内的安装状态。
 * app 插件按哈希归属判断，所以随便改个同名的文件不会被误判成该插件。
 * 本地探测（node_modules + plugins 目录）覆盖市场的探测结果，市场里没有的本地插件补成未知来源条目。
 */
export async function loadPluginSnapshot(force = false): Promise<PluginSnapshot> {
  const [market, dirFiles, manifest, local] = await Promise.all([
    fetchPlugins(force),
    listAppPluginDir(),
    readAppManifest(),
    scanLocalPlugins(),
  ]);
  const stored = await listExistingPlugins(market.filter(plugin => plugin.type !== 'app').map(pluginProbe));
  const localByName = new Map(local.map(item => [item.name, item]));
  const marketNames = new Set(market.map(plugin => plugin.name));
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

  const plugins: Plugin[] = market.map(plugin => {
    if (plugin.type === 'app') {
      const installedFiles = matches.get(plugin.name) ?? [];
      return {...plugin, installed: installedFiles.length > 0, installedFiles};
    }
    /** 本地探测到的（含 pnpm 装的）优先：市场那条命令探不到时以本地目录为准 */
    return {...plugin, installed: stored.has(plugin.name) || localByName.has(plugin.name), installedFiles: undefined};
  });

  local.forEach(item => {
    if (marketNames.has(item.name)) return;
    const githubUrl = item.remote ? githubUrlFrom(item.remote) : undefined;
    plugins.push({
      name: item.name,
      type: item.type,
      description: '本地安装（插件市场里没有这个条目）',
      installed: true,
      local: true,
      homepage: githubUrl,
      repo: item.remote ? [{type: 'git', url: item.remote}] : undefined,
    });
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

export async function fetchPluginDetails(plugin: Plugin): Promise<PluginDetails> {
  const cached = detailCache.get(plugin.name);
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
    githubUrl: githubUrlFrom(repositoryUrl) ?? githubUrlFrom(plugin.homepage),
    npmUrl: npmPackageUrl(plugin.name),
  };
  detailCache.set(plugin.name, details);
  return details;
}

/** Karin 项目里的 pnpm 命令：有 workspace 就带上 -w，否则直接跑 */
const pnpmCommand = (args: string) =>
  `cd ${KARIN_DIR} && if test -f pnpm-workspace.yaml; then pnpm -w ${args}; else pnpm ${args}; fi`;

const npmInstallCommand = (plugin: Plugin) => pnpmCommand(`i ${shellQuote(plugin.name)}`);

const gitInstallCommand = (plugin: Plugin) => {
  const repository = plugin.repo?.find(item => item.type !== 'npm' && item.url);
  if (!repository?.url) throw new Error('Git 插件缺少可用仓库地址');
  const path = pluginPath(plugin);
  const branch = repository.branch?.trim();
  const branchArgument = branch ? ` --branch ${shellQuote(branch)}` : '';
  /** 用户填了 GitHub 加速前缀时，clone/fetch 都走加速地址 */
  const repositoryUrl = proxiedUrl(repository.url);
  return [
    `command -v git >/dev/null 2>&1 || (apt-get update && apt-get install -y git)`,
    `mkdir -p ${shellQuote(`${KARIN_DIR}/plugins`)}`,
    `if test -d ${shellQuote(`${path}/.git`)}; then git -C ${shellQuote(path)} remote set-url origin ${shellQuote(repositoryUrl)} && git -C ${shellQuote(path)} fetch --depth 1 origin ${shellQuote(branch ?? 'HEAD')} && git -C ${shellQuote(path)} reset --hard FETCH_HEAD; else rm -rf ${shellQuote(path)} && git clone --depth 1${branchArgument} ${shellQuote(repositoryUrl)} ${shellQuote(path)}; fi`,
    `if test -f ${shellQuote(`${path}/package.json`)}; then cd ${shellQuote(path)} && pnpm i; fi`,
  ].join(' && ');
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
  const command = plugin.type === 'git' ? gitInstallCommand(plugin) : npmInstallCommand(plugin);
  return executeStreaming(command, onLog, 5 * 60 * 1000, signal);
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
  /** devDependencies 里的依赖 */
  dev?: boolean;
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
  const collect = (field: string, dev: boolean) => {
    const entries = source[field];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return;
    Object.entries(entries as Record<string, unknown>).forEach(([name, spec]) => {
      if (dev && merged.has(name)) return;
      merged.set(name, {
        name,
        spec: typeof spec === 'string' ? spec : '',
        dev: dev || undefined,
        plugin: isPluginPackageName(name),
        core: isKarinCorePackage(name),
      });
    });
  };
  collect('dependencies', false);
  collect('devDependencies', true);
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
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
) => {
  if (!names.length) throw new Error('请填写要安装的依赖');
  return executeStreaming(pnpmCommand(`i ${names.map(shellQuote).join(' ')}`), onLog, 5 * 60 * 1000, signal);
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
