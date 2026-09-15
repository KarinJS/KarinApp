import {NativeModules} from 'react-native';

export type ImportedAppPlugin = {
  /** 落地到容器里的文件名（取自系统文件选择器给的显示名） */
  name: string;
  size: number;
};

export type ImportedKarinPluginArchive = {
  /** package.json 里的原始 name（可能带 @scope/） */
  name: string;
  /** 实际写入 plugins/ 的目录名；带 scope 的包会去掉 scope */
  directoryName: string;
  /** 目标目录已经存在且不为空，需要用户确认覆盖 */
  conflict: boolean;
  warning?: string;
  size: number;
};

export type ImportedKarinPluginResult = {
  name: string;
  directoryName: string;
  overwritten: boolean;
};

type NativeAppPluginImport = {
  pickFile: (relativeDir: string) => Promise<ImportedAppPlugin | null>;
  pickFileCancellable?: (relativeDir: string, taskId: string) => Promise<ImportedAppPlugin | null>;
  pickArchive?: () => Promise<string | null>;
  inspectArchive?: (uri: string, taskId: string) => Promise<ImportedKarinPluginArchive>;
  importArchive?: (uri: string, overwrite: boolean, taskId: string) => Promise<ImportedKarinPluginResult>;
  cancelImport?: (taskId: string) => Promise<boolean>;
  finishImport?: (taskId: string) => Promise<boolean>;
};

/** 原生层负责把选中的文件复制进 rootfs；旧版本 App 没有这个方法 */
const native = NativeModules.KarinAppPluginImport as NativeAppPluginImport | undefined;

export const canImportLocalAppPlugin = () => Boolean(native?.pickFile);

/**
 * 让用户从系统文件选择器挑一个 app 插件文件，复制进容器的 relativeDir（相对 rootfs 根，例如
 * root/karin/plugins/karin-plugin-example）。用户取消时返回 null。
 */
export const importLocalAppPlugin = async (relativeDir: string, signal?: AbortSignal): Promise<ImportedAppPlugin | null> => {
  if (!native?.pickFile) throw new Error('当前版本不支持从本地文件导入，请更新 App 后重试');
  if (!native.pickFileCancellable) {
    if (signal) throw new Error('当前版本不支持可终止的文件导入，请更新 App 后重试');
    return native.pickFile(relativeDir);
  }
  const taskId = `app-file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const checkCancelled = () => { if (signal?.aborted) throw new Error('任务已终止'); };
  const abort = () => { cancelKarinPluginImport(taskId).catch(() => {}); };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    checkCancelled();
    const result = await native.pickFileCancellable(relativeDir, taskId);
    checkCancelled();
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    await finishKarinPluginImport(taskId).catch(() => {});
  }
};

/** 当前版本是否支持从 zip 导入目录型 Karin 插件。 */
export const canImportKarinPluginArchive = () => Boolean(native?.pickArchive && native?.inspectArchive && native?.importArchive);

/** 打开系统文件选择器，返回所选压缩包 URI；取消时返回 null。 */
export const pickKarinPluginArchive = async () => {
  if (!native?.pickArchive) throw new Error('当前版本不支持从压缩包导入插件，请更新 App 后重试');
  return native.pickArchive();
};

/** 校验压缩包根 package.json，并返回目标目录及重复警告。 */
export const inspectKarinPluginArchive = async (uri: string, taskId = `plugin-inspect-${Date.now()}`) => {
  if (!native?.inspectArchive) throw new Error('当前版本不支持校验插件压缩包，请更新 App 后重试');
  return native.inspectArchive(uri, taskId);
};

/** 解压插件；overwrite 仅在用户确认目标目录覆盖后传 true。 */
export const importKarinPluginArchive = async (uri: string, overwrite = false, taskId = `plugin-import-${Date.now()}`) => {
  if (!native?.importArchive) throw new Error('当前版本不支持从压缩包导入插件，请更新 App 后重试');
  return native.importArchive(uri, overwrite, taskId);
};

/** 终止正在校验或解压的任务；已完成最终目录替换时返回 false。 */
export const cancelKarinPluginImport = async (taskId: string) => {
  if (!native?.cancelImport) throw new Error('当前版本不支持终止插件导入，请更新 App 后重试');
  return native.cancelImport(taskId);
};

/** 释放导入任务缓存；确认取消覆盖、导入成功或失败时都应调用。 */
export const finishKarinPluginImport = async (taskId: string) => {
  if (!native?.finishImport) return false;
  return native.finishImport(taskId);
};
