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
};

type RemoveOptions = {
  /** 指定要删除的文件名，用于 karin-plugin-example 目录条目 */
  appFiles?: string[];
};

export const npmPackageUrl = (name: string) => `https://www.npmjs.com/package/${name}`;

const KARIN_DIR = '/root/karin';
const PLUGIN_TYPES = new Set<PluginType>(['npm', 'git', 'app']);

/**
 * Karin 约定：所有 app 类型插件的 .js 文件都放在这个目录，Karin 启动时按文件加载。
 * 所以 app 插件只能按文件维度管理，不能按插件名建目录。
 */
export const APP_PLUGIN_DIR = 'karin-plugin-example';

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
  const raw = await fetch(PLUGIN_LIST_URL).then(response => { if (!response.ok) throw new Error(`插件列表请求失败 (${response.status})`); return response.json(); });
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

/**
 * 拉取插件市场 + 容器内的安装状态。
 * app 插件按哈希归属判断，所以随便改个同名的文件不会被误判成该插件。
 */
export async function loadPluginSnapshot(force = false): Promise<PluginSnapshot> {
  const [market, dirFiles, manifest] = await Promise.all([
    fetchPlugins(force),
    listAppPluginDir(),
    readAppManifest(),
  ]);
  const stored = await listExistingPlugins(market.filter(plugin => plugin.type !== 'app').map(pluginProbe));
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

  return {
    plugins: market.map(plugin => {
      if (plugin.type === 'app') {
        const installedFiles = matches.get(plugin.name) ?? [];
        return {...plugin, installed: installedFiles.length > 0, installedFiles};
      }
      return {...plugin, installed: stored.has(plugin.name), installedFiles: undefined};
    }),
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

const npmInstallCommand = (plugin: Plugin) => {
  const packageName = shellQuote(plugin.name);
  return `cd ${KARIN_DIR} && if test -f pnpm-workspace.yaml; then pnpm -w i ${packageName}; else pnpm i ${packageName}; fi`;
};

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
      return [];
    }
    const target = options.renames?.[name]?.trim() || name;
    if (!isSafeFileName(target)) throw new Error(`目标文件名不合法：${target}`);
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
      await recordAppInstall(plugin, plan.map(item => item.target));
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
        ? `cd ${KARIN_DIR} && if test -f pnpm-workspace.yaml; then pnpm -w remove ${shellQuote(plugin.name)}; else pnpm remove ${shellQuote(plugin.name)}; fi`
        : `rm -rf -- ${shellQuote(pluginPath(plugin))}`;
  return executeStreaming(command, onLog, 5 * 60 * 1000, signal);
};
