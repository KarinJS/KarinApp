import {executeAndCollect} from './prootController';
import {shellQuote} from '../utils/shell';

/** 版本号形态：semver，允许 prerelease / build 后缀；dist-tag、范围表达式不进列表。 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][\w.]+)*$/;

const VERSION_QUERY_TIMEOUT_MS = 30 * 1000;

/** 版本列表缓存 15 分钟，期间改版本不再重复请求 npm。 */
const CACHE_TTL_MS = 15 * 60 * 1000;

type CacheEntry = {
  versions: string[];
  at: number;
};

const cache = new Map<string, CacheEntry>();
/** 同一个包并发查询时共用一次请求（下拉点快了不会打出多条命令） */
const inflight = new Map<string, Promise<string[]>>();

const prune = (now: number) => {
  cache.forEach((entry, key) => {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
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
 * npm registry 上的全部发布版本，从新到旧。15 分钟内的缓存直接返回，
 * force 用于「强制刷新」（先丢掉这个包的缓存再查）。
 */
export async function fetchPackageVersions(name: string, options: {force?: boolean} = {}): Promise<string[]> {
  const key = name.trim();
  if (!key) throw new Error('缺少依赖名');
  const now = Date.now();
  if (options.force) cache.delete(key);
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.versions;
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

/** 强制刷新：不传名字清空全部，传了就只清这一个包。 */
export function clearPackageVersionCache(name?: string) {
  if (name) cache.delete(name.trim());
  else cache.clear();
}

/** 有没有可用的缓存（下拉里用来提示「15 分钟内不重复请求」） */
export const hasPackageVersionCache = (name: string) => {
  const entry = cache.get(name.trim());
  return entry !== undefined && Date.now() - entry.at < CACHE_TTL_MS;
};