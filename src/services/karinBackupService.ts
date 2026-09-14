import {DeviceEventEmitter, NativeModules, Platform} from 'react-native';
import {ensureKarinInitializedAfterImport} from './environmentService';

export type BackupOperation = 'export' | 'import';
export type BackupPhase = 'idle' | 'picking' | 'validating' | 'scanning' | 'staging' | 'committing' | 'installing' | 'cloning' | 'completed' | 'failed' | 'cancelled' | 'paused';

export type BackupProgress = {
  taskId: string;
  operation: BackupOperation;
  phase: BackupPhase;
  progress: number;
  current?: string;
  message?: string;
  completedFiles?: number;
  totalFiles?: number;
  completedBytes?: number;
  totalBytes?: number;
  logs?: string[];
  done?: boolean;
  error?: string;
};

export type BackupTask = BackupProgress & {logs: string[]};

export type BackupExportOptions = {
  /** Git 插件仅写入 URL、分支和 commit；本地插件与 APP 插件仍完整导出。 */
  pluginListOnly: boolean;
};

type NativeBackup = {
  startExport?: (options: BackupExportOptions & {fileName?: string}) => Promise<string | null>;
  exportToUri?: (uri: string, pluginListOnly: boolean) => Promise<unknown>;
  startImport?: (uri?: string, overwrite?: boolean) => Promise<string | null>;
  inspectImport?: (uri: string) => Promise<{rootDir?: string; files?: number; pluginListOnly?: boolean; conflicts?: string[]}>;
  prepareImport?: (uri: string) => Promise<{taskId: string; rootDir?: string; files?: number; conflicts?: string[]}>;
  resolveConflict?: (taskId: string, path: string, action: 'replace' | 'skip', applyAll: boolean) => Promise<boolean>;
  commitImport?: (taskId: string) => Promise<unknown>;
  finishTask?: (taskId: string) => Promise<boolean>;
  importFromUri?: (uri: string, overwrite: boolean) => Promise<unknown>;
  resumeTask?: (taskId: string, overwrite?: boolean) => Promise<boolean>;
  cancelTask?: (taskId: string) => Promise<boolean>;
  cancelImport?: (taskId: string) => Promise<boolean>;
  discardTask?: (taskId: string) => Promise<boolean>;
  getActiveTask?: () => Promise<BackupTask | BackupPending[] | null>;
};

export type BackupPending = {taskId: string; state: string; done?: number; total?: number; logs?: string[]};

const native = NativeModules.KarinBackup as NativeBackup | undefined;
const listeners = new Set<(task: BackupTask | null) => void>();
let currentTask: BackupTask | null = null;

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

const emit = (task: BackupTask | null) => {
  currentTask = task;
  listeners.forEach(listener => listener(task));
};

const appendLog = (task: BackupTask, line: string) => {
  if (!line) return;
  const logs = [...task.logs, line];
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  task.logs = logs;
};

function normalizeEvent(value: Partial<BackupProgress> & {task?: Partial<BackupProgress>; log?: string; phase?: string}): BackupTask {
  const nested = value.task ?? {};
  const previous = currentTask;
  const operation = (value.operation ?? nested.operation ?? previous?.operation ?? 'import') as BackupOperation;
  const rawStage = (value as Partial<BackupProgress> & {stage?: string}).stage ?? (nested as Partial<BackupProgress> & {stage?: string}).stage;
  const mappedStage = rawStage === 'export' ? 'staging' : rawStage === 'import' ? 'committing' : rawStage;
  const phase = (value.phase ?? nested.phase ?? mappedStage ?? previous?.phase ?? 'scanning') as BackupPhase;
  const done = (value as Partial<BackupProgress> & {done?: number}).done;
  const total = (value as Partial<BackupProgress> & {total?: number}).total;
  const task: BackupTask = {
    ...(previous ?? {}),
    ...(nested as BackupTask),
    ...value,
    taskId: value.taskId ?? nested.taskId ?? previous?.taskId ?? `backup-${Date.now()}`,
    operation,
    phase,
    progress: typeof value.progress === 'number' ? value.progress : (typeof nested.progress === 'number' ? nested.progress : (typeof done === 'number' && typeof total === 'number' && total > 0 ? done / total : previous?.progress ?? 0)),
    completedFiles: value.completedFiles ?? (typeof done === 'number' ? done : previous?.completedFiles),
    totalFiles: value.totalFiles ?? (typeof total === 'number' ? total : previous?.totalFiles),
    logs: Array.isArray(value.logs) ? value.logs : (Array.isArray(nested.logs) ? nested.logs : [...(previous?.logs ?? [])]),
  };
  delete (task as Partial<BackupProgress> & {task?: unknown}).task;
  appendLog(task, value.log ?? '');
  return task;
}

if (Platform.OS === 'android') {
  DeviceEventEmitter.addListener('KarinBackupProgress', value => emit(normalizeEvent(value ?? {})));
  DeviceEventEmitter.addListener('KarinBackupTask', value => emit(normalizeEvent(value ?? {})));
  DeviceEventEmitter.addListener('KarinBackupLog', value => {
    if (!currentTask) return;
    const task = {...currentTask, logs: [...currentTask.logs]};
    if (value?.taskId) task.taskId = value.taskId;
    appendLog(task, value?.message ?? value?.log ?? '');
    emit(task);
  });
}

export const isBackupAvailable = () => Boolean(native?.startExport && native?.startImport);
export const subscribeBackup = (listener: (task: BackupTask | null) => void) => {
  listeners.add(listener);
  listener(currentTask);
  return () => { listeners.delete(listener); };
};
export const getBackupTask = () => currentTask;
export const clearBackupTask = () => emit(null);

export async function refreshBackupTask() {
  if (!native?.getActiveTask) return currentTask;
  try {
    const value = await native.getActiveTask();
    if (Array.isArray(value)) {
      const pending = value[0];
      if (pending) emit({taskId: pending.taskId, operation: 'import', phase: pending.state === 'done' ? 'completed' : pending.state === 'failed' ? 'failed' : 'paused', progress: pending.total ? (pending.done ?? 0) / pending.total : 0, completedFiles: pending.done, totalFiles: pending.total, logs: [...(pending.logs ?? []), `恢复任务：${pending.state}`]});
    } else if (value) emit({...value, logs: value.logs ?? []});
    return currentTask;
  } catch {
    return currentTask;
  }
}

export async function startBackupExport(options: BackupExportOptions) {
  if (!native?.startExport) throw new Error('当前版本不支持 Karin 备份导出');
  emit({taskId: `export-${Date.now()}`, operation: 'export', phase: 'picking', progress: 0, logs: ['等待选择导出文件位置…']});
  const uri = await native.startExport({...options, fileName: 'karin-backup.zip'});
  if (!uri) { emit(null); return null; }
  if (native.exportToUri) {
    await native.exportToUri(uri, options.pluginListOnly);
    if (currentTask) emit({...currentTask, phase: 'completed', progress: 1, message: '导出完成', logs: [...currentTask.logs, '导出完成']});
  }
  else throw new Error('当前版本缺少备份导出接口');
  return currentTask?.taskId ?? null;
}

export async function startBackupImport() {
  if (!native?.startImport) throw new Error('当前版本不支持 Karin 备份导入');
  emit({taskId: `import-${Date.now()}`, operation: 'import', phase: 'picking', progress: 0, logs: ['等待选择 Karin 备份文件…']});
  return native.startImport();
}

/** 打开系统选择器并返回 URI；调用方展示冲突提示后再调用 importBackupUri。 */
export async function pickBackupImport() {
  if (!native?.startImport) throw new Error('当前版本不支持 Karin 备份导入');
  emit({taskId: `import-${Date.now()}`, operation: 'import', phase: 'picking', progress: 0, logs: ['等待选择 Karin 备份文件…']});
  const uri = await native.startImport();
  if (!uri) emit(null);
  return uri;
}

export async function inspectBackupImport(uri: string) {
  return native?.inspectImport ? native.inspectImport(uri) : null;
}

export async function importBackupUri(uri: string, overwrite: boolean) {
  if (!native?.importFromUri) throw new Error('当前版本缺少备份导入接口');
  const result = await native.importFromUri(uri, overwrite);
  await ensureKarinInitializedAfterImport(line => {
    const task = currentTask ? {...currentTask, logs: [...currentTask.logs]} : null;
    if (task) { appendLog(task, line); emit(task); }
  });
  if (currentTask) emit({...currentTask, phase: 'completed', progress: 1, message: '导入完成', logs: [...currentTask.logs, '导入完成']});
  return result;
}

export async function prepareBackupImport(uri: string) {
  if (!native?.prepareImport) throw new Error('当前版本缺少备份预处理接口');
  return native.prepareImport(uri);
}

export async function resolveBackupConflict(taskId: string, path: string, action: 'replace' | 'skip', applyAll: boolean) {
  if (!native?.resolveConflict) throw new Error('当前版本缺少冲突处理接口');
  return native.resolveConflict(taskId, path, action, applyAll);
}

export async function commitBackupImport(taskId: string) {
  if (!native?.commitImport) throw new Error('当前版本缺少备份提交接口');
  return native.commitImport(taskId);
}

export async function finishBackupTask(taskId: string) {
  if (!native?.finishTask) throw new Error('当前版本缺少备份收尾接口');
  return native.finishTask(taskId);
}

export async function resumeBackupTask(taskId: string) {
  if (!native?.resumeTask) throw new Error('当前版本不支持继续导入');
  return native.resumeTask(taskId, false);
}
export async function cancelBackupTask(taskId: string) {
  const cancel = native?.cancelTask ?? native?.cancelImport;
  if (!cancel) throw new Error('当前版本不支持取消导入');
  const result = await cancel(taskId);
  if (currentTask) emit({...currentTask, phase: 'cancelled', message: '任务已取消', logs: [...currentTask.logs, '任务已取消并清理']});
  return result;
}
export async function discardBackupTask(taskId: string) {
  if (!native?.discardTask) throw new Error('当前版本不支持清理导入任务');
  return native.discardTask(taskId);
}

export const backupErrorMessage = messageOf;
