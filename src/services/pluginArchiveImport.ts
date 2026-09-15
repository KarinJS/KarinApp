import {
  canImportKarinPluginArchive,
  cancelKarinPluginImport,
  finishKarinPluginImport,
  importKarinPluginArchive,
  inspectKarinPluginArchive,
  pickKarinPluginArchive,
} from './appPluginImport';

type ArchiveImportOptions = {
  signal: AbortSignal;
  onLog: (line: string) => void;
  onWarning: (warning: {title: string; message: string}) => Promise<boolean>;
  onName?: (name: string) => void;
};

/** 选择、校验和导入均留在服务层，页面只处理任务状态。 */
export async function importLocalPluginArchive({signal, onLog, onWarning, onName}: ArchiveImportOptions) {
  if (!canImportKarinPluginArchive()) throw new Error('当前版本不支持从压缩包导入插件，请更新 App 后重试');
  const taskId = `plugin-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const checkCancelled = () => {
    if (signal.aborted) throw new Error('任务已终止');
  };
  const abort = () => { cancelKarinPluginImport(taskId).catch(() => {}); };
  signal.addEventListener('abort', abort, {once: true});
  try {
    checkCancelled();
    onLog('请在系统文件选择器里选一个 ZIP 插件压缩包…');
    const uri = await pickKarinPluginArchive();
    checkCancelled();
    if (!uri) return null;
    onLog('正在校验压缩包根目录的 package.json…');
    const archive = await inspectKarinPluginArchive(uri, taskId);
    checkCancelled();
    onName?.(archive.name);
    onLog(`插件：${archive.name}`);
    onLog(`目标：plugins/${archive.directoryName}`);
    let overwrite = false;
    if (archive.conflict) {
      overwrite = await onWarning({
        title: '插件已存在',
        message: `plugins/${archive.directoryName} 已存在且不为空，是否覆盖？`,
      });
      checkCancelled();
      if (!overwrite) {
        onLog('已取消覆盖，保留原插件');
        return null;
      }
    }
    onLog('正在解压插件文件…');
    const result = await importKarinPluginArchive(uri, overwrite, taskId);
    checkCancelled();
    onLog(`已导入 ${result.name} → plugins/${result.directoryName}${result.overwritten ? '（已覆盖）' : ''}`);
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    await finishKarinPluginImport(taskId).catch(() => {});
  }
}
