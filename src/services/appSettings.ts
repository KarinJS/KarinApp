import {executeAndCollect} from './prootController';

/** 应用设置放在容器里，跟着容器持久化，重装 App 也不会丢 */
const SETTINGS_DIR = '/root/.karinapp';
const SETTINGS_PATH = `${SETTINGS_DIR}/settings.json`;

export type AppSettings = {
  /** GitHub 加速前缀（例如 https://ghfast.top/），空字符串表示直连 */
  githubProxy: string;
};

const DEFAULT_SETTINGS: AppSettings = {githubProxy: ''};

let cache: AppSettings = {...DEFAULT_SETTINGS};
let loaded = false;
let loading: Promise<AppSettings> | null = null;

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** 统一成带协议、带结尾斜杠的前缀，方便直接拼在原链接前面 */
export const normalizeGithubProxy = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.endsWith('/') ? withScheme : `${withScheme}/`;
};

/** 留空表示直连，不算错误 */
export const isValidGithubProxy = (value: string) => {
  const normalized = normalizeGithubProxy(value);
  if (!normalized) return true;
  try {
    const url = new URL(normalized);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.');
  } catch {
    return false;
  }
};

const GITHUB_URL = /^https?:\/\/(?:[\w-]+\.)*(?:github\.com|githubusercontent\.com|githubassets\.com)\//i;

/** 只给 GitHub 的链接套加速前缀，其它地址原样返回 */
export const proxiedUrl = (url: string) => {
  if (!cache.githubProxy || !GITHUB_URL.test(url)) return url;
  return `${cache.githubProxy}${url}`;
};

export const getGithubProxy = () => cache.githubProxy;

const readSettings = async (): Promise<AppSettings> => {
  const output = await executeAndCollect(`cat ${shellQuote(SETTINGS_PATH)} 2>/dev/null || true`);
  const parsed: unknown = JSON.parse(output.trim() || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {...DEFAULT_SETTINGS};
  const {githubProxy} = parsed as {githubProxy?: unknown};
  return {githubProxy: typeof githubProxy === 'string' ? normalizeGithubProxy(githubProxy) : ''};
};

const writeSettings = async (settings: AppSettings) => {
  const payload = JSON.stringify({githubProxy: settings.githubProxy});
  await executeAndCollect(
    `mkdir -p ${shellQuote(SETTINGS_DIR)} && printf '%s' ${shellQuote(payload)} > ${shellQuote(SETTINGS_PATH)}`,
  );
};

/**
 * 安装命令是同步拼出来的，所以设置要先加载一次；加载过之后直接走缓存。
 */
export async function loadAppSettings(force = false): Promise<AppSettings> {
  if (loaded && !force) return cache;
  if (loading && !force) return loading;
  loading = readSettings()
    .then(settings => {
      cache = settings;
      loaded = true;
      return cache;
    })
    .catch(() => cache)
    .finally(() => {
      loading = null;
    });
  return loading;
}

export async function saveGithubProxy(value: string): Promise<string> {
  const githubProxy = normalizeGithubProxy(value);
  cache = {...cache, githubProxy};
  loaded = true;
  await writeSettings(cache);
  return githubProxy;
}
