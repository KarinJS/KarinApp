import {executeAndCollect} from './prootController';
import {shellQuote} from '../utils/shell';

/** 版本号形态：semver，允许 prerelease / build 后缀；dist-tag、范围表达式不进列表。 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][\w.]+)*$/;

/**
 * 从 npm 发布版本列表里挑选适合展示的最新稳定版。
 * npm 的 versions 数组可能把 prerelease 放在末尾，UI 不应因此把 beta
 * 当作“最新版本”；若列表只有 prerelease，则退回列表第一项。
 */
export const pickLatestStableVersion = (versions: string[]): string | undefined =>
  versions.find(version => !version.includes('-')) ?? versions[0];

const VERSION_QUERY_TIMEOUT_MS = 30 * 1000;

/** 版本列表缓存 1 小时，期间改版本不再重复请求 npm。 */
export const PACKAGE_VERSION_CACHE_TTL_MS = 60 * 60 * 1000;

type CacheEntry = {
  versions: string[];
  at: number;
};

const cache = new Map<string, CacheEntry>();
/** 同一个包并发查询时共用一次请求（下拉点快了不会打出多条命令） */
const inflight = new Map<string, Promise<string[]>>();

const prune = (now: number) => {
  cache.forEach((entry, key) => {
    if (now - entry.at >= PACKAGE_VERSION_CACHE_TTL_MS) cache.delete(key);
  });
};

async function queryVersions(name: string): Promise<string[]> {
  const output = await executeAndCollect(`npm view ${shellQuote(name)} versions --json 2>/dev/null`, VERSION_QUERY_TIMEOUT_MS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error('没有查询到可用版本，可能不是 npm 包');
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const versions = list.filter((item): item is string => typeof item === 'string' && VERSION_RE.test(item));
  if (versions.length === 0) throw new Error('没有查询到可用版本，可能不是 npm 包');
  return versions.reverse();
}

/**
 * npm registry 上的全部发布版本，从新到旧。1 小时内的缓存直接返回，
 * force 用于「强制刷新」（先丢掉这个包的缓存再查）。
 */
export async function fetchPackageVersions(name: string, options: {force?: boolean} = {}): Promise<string[]> {
  const key = name.trim();
  if (!key) throw new Error('缺少依赖名');
  const now = Date.now();
  if (options.force) cache.delete(key);
  const cached = cache.get(key);
  if (cached && now - cached.at < PACKAGE_VERSION_CACHE_TTL_MS) return cached.versions;
  if (cached) cache.delete(key);
  const running = inflight.get(key);
  if (running) return running;
  const task = queryVersions(key)
    .then(versions => {
      prune(Date.now());
      cache.set(key, {versions, at: Date.now()});
      return versions;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

/**
 * 预加载多个依赖的版本列表并写入缓存。
 *
 * 依赖管理首次打开时可以调用此方法，让后续打开单个依赖的版本菜单时
 * 直接命中缓存。单个包查询失败不会阻塞其它包，返回值只包含成功结果。
 */
export async function preloadPackageVersions(
  names: string[],
  options: {force?: boolean} = {},
): Promise<Record<string, string[]>> {
  const unique = [...new Set(names.map(name => name.trim()).filter(Boolean))];
  const result: Record<string, string[]> = {};
  let nextIndex = 0;
  // 每次查询都会启动一个 npm 进程，限制并发以免手机容器的瞬时内存过高。
  const workers = Array.from({length: Math.min(3, unique.length)}, async () => {
    while (nextIndex < unique.length) {
      const name = unique[nextIndex++];
      try {
        result[name] = await fetchPackageVersions(name, options);
      } catch {
        // Git URL、本地包等没有 registry 版本的依赖不影响其它依赖预取。
      }
    }
  });
  await Promise.all(workers);
  return result;
}

/** 强制刷新：不传名字清空全部，传了就只清这一个包。 */
export function clearPackageVersionCache(name?: string) {
  if (name) cache.delete(name.trim());
  else cache.clear();
}

/** 有没有可用的缓存（下拉里用来提示「1 小时内不重复请求」） */
export const hasPackageVersionCache = (name: string) => {
  const entry = cache.get(name.trim());
  return entry !== undefined && Date.now() - entry.at < PACKAGE_VERSION_CACHE_TTL_MS;
};
