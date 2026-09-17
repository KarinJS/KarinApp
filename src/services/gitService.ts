import {DeviceEventEmitter, NativeModules} from 'react-native';

export type GitLogEntry = {
  hash: string;
  subject: string;
  author: string;
  date: string;
};

export type GitLocalRepository = {
  name: string;
  path: string;
  remote: string;
};

type NativeGitModule = {
  isRepository(path: string): Promise<boolean>;
  pathState(path: string): Promise<string>;
  listRepositories(): Promise<string>;
  clone(url: string, path: string, branch: string | null, depth: number, operationId: string): Promise<unknown>;
  update(url: string, path: string, branch: string | null, operationId: string): Promise<unknown>;
  fetch(path: string, unshallow: boolean, prune: boolean, operationId: string): Promise<unknown>;
  checkout(path: string, hash: string, operationId: string): Promise<unknown>;
  status(path: string, includeUntracked: boolean): Promise<string>;
  log(path: string, limit: number): Promise<string>;
  head(path: string): Promise<string>;
  remoteUrl(path: string): Promise<string>;
  setRemoteUrl(path: string, url: string): Promise<unknown>;
  isShallow(path: string): Promise<boolean>;
  cancel(operationId: string): Promise<unknown>;
};

export type GitOperationOptions = {
  onLog?: (line: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const getNative = () => {
  const native = NativeModules.KarinGit as NativeGitModule | undefined;
  if (!native) throw new Error('KarinGit 原生模块不可用，请重新安装包含 libgit2 的应用版本');
  return native;
};

/** Git 直接操作 rootfs 文件；网络、进度和取消均由 Android 的 libgit2 处理。 */
const run = async (
  execute: (native: NativeGitModule, operationId: string) => Promise<unknown>,
  options: GitOperationOptions = {},
): Promise<void> => {
  if (options.signal?.aborted) throw new Error('任务已终止');
  const native = getNative();
  const operationId = `git-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let terminationError: Error | undefined;
  const terminate = (message: string) => {
    if (terminationError) return;
    terminationError = new Error(message);
    // 取消只设置原生任务标记；必须等 Promise 在清理完临时目录后结束，才能释放任务锁。
    native.cancel(operationId).catch(() => {});
  };
  const onAbort = () => terminate('任务已终止');
  const subscription = DeviceEventEmitter.addListener(
    'KarinGitProgress',
    (event: {operationId: string; message: string}) => {
      if (event.operationId !== operationId || !event.message) return;
      try { options.onLog?.(event.message); } catch {}
    },
  );
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const timer = setTimeout(() => terminate(`Git 操作超时（${timeoutMs}ms）`), timeoutMs);
  options.signal?.addEventListener('abort', onAbort, {once: true});
  try {
    // 注册取消监听到 native 调用之间没有 await，避免先取消后开始的竞态。
    await execute(native, operationId);
    if (terminationError) throw terminationError;
  } catch (error) {
    throw terminationError ?? error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    subscription.remove();
  }
};

export const gitService = {
  isRepository: (path: string) => getNative().isRepository(path),
  /** missing / empty / occupied，错误由原生抛出，不能误判成空目录。 */
  pathState: (path: string) => getNative().pathState(path),
  listRepositories: async (): Promise<GitLocalRepository[]> => JSON.parse(await getNative().listRepositories()),
  clone: (url: string, path: string, branch?: string, options?: GitOperationOptions) =>
    run((native, id) => native.clone(url, path, branch?.trim() || null, 1, id), options),
  update: (url: string, path: string, branch?: string, options?: GitOperationOptions) =>
    run((native, id) => native.update(url, path, branch?.trim() || null, id), options),
  fetch: (path: string, options: GitOperationOptions & {unshallow?: boolean; prune?: boolean} = {}) =>
    run((native, id) => native.fetch(path, options.unshallow === true, options.prune === true, id), options),
  checkout: (path: string, hash: string, options?: GitOperationOptions) =>
    run((native, id) => native.checkout(path, hash, id), options),
  log: async (path: string, limit = 100): Promise<GitLogEntry[]> => JSON.parse(await getNative().log(path, limit)),
  head: (path: string) => getNative().head(path),
  remoteUrl: (path: string) => getNative().remoteUrl(path),
  setRemoteUrl: (path: string, url: string) => getNative().setRemoteUrl(path, url),
  isShallow: (path: string) => getNative().isShallow(path),
  /** 只统计已跟踪文件，node_modules 等未跟踪内容不阻止版本切换。 */
  status: async (path: string): Promise<{dirty: boolean; output: string}> => JSON.parse(await getNative().status(path, false)),
};
