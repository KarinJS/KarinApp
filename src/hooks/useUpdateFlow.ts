import {useCallback, useEffect, useState} from 'react';
import {
  checkForUpdate,
  downloadUpdate,
  formatSize,
  getUpdateState,
  installDownloadedUpdate,
  openInstallPermission,
  refreshAppInfo,
  subscribeUpdate,
} from '../services/updateService';
import type {UpdatePhase, UpdateState} from '../services/updateService';

export type UpdateDialog = 'download' | 'install' | 'permission' | null;

/**
 * 检查/下载/安装更新的界面流程。进度状态放在 updateService 单例里，
 * 所以切页面、切标签都不会丢；设置页和关于页共用这一套逻辑。
 */
export function useUpdateFlow() {
  const [update, setUpdate] = useState<UpdateState>(getUpdateState);
  const [dialog, setDialog] = useState<UpdateDialog>(null);

  useEffect(() => subscribeUpdate(setUpdate), []);

  useEffect(() => {
    refreshAppInfo().catch(() => {});
  }, []);

  const busy = update.phase === 'checking' || update.phase === 'downloading';
  const status = update.message || `当前版本 v${update.appVersion || '未知'}`;
  const releaseNotes = update.release?.notes ? update.release.notes.slice(0, 500) : '暂无更新说明';
  /** 有半截包时改成「已下载多少、从断点继续」，否则展示整包大小 */
  const downloadSummary = update.partial
    ? `上次已下载 ${formatSize(update.partial.received)}${
        update.partial.total > 0
          ? ` / ${formatSize(update.partial.total)}（${Math.floor((update.partial.received / update.partial.total) * 100)}%）`
          : ''
      }，将从断点继续。`
    : `安装包大小：${formatSize(update.release?.size ?? 0)}`;

  /** 返回结束状态：idle=已是最新，available=有新版本，ready=已下载待安装，error=失败 */
  const check = useCallback(async (): Promise<UpdatePhase> => {
    if (busy) return getUpdateState().phase;
    /** 已有下载好或待续传的版本时，直接回到对应弹窗，不必重新检查 */
    if (update.phase === 'ready') {
      setDialog('install');
      return 'ready';
    }
    if (update.phase === 'available' && update.release) {
      setDialog('download');
      return 'available';
    }
    await checkForUpdate().catch(() => {});
    const next = getUpdateState();
    if (next.phase === 'ready') setDialog('install');
    else if (next.phase === 'available') setDialog('download');
    return next.phase;
  }, [busy, update.phase, update.release]);

  const confirmDownload = useCallback(async () => {
    setDialog(null);
    await downloadUpdate().catch(() => {});
    if (getUpdateState().phase === 'ready') setDialog('install');
  }, []);

  const confirmInstall = useCallback(async () => {
    setDialog(null);
    const result = await installDownloadedUpdate().catch(() => 'failed' as const);
    if (result === 'permission') setDialog('permission');
  }, []);

  const confirmPermission = useCallback(() => {
    setDialog(null);
    openInstallPermission().catch(() => {});
  }, []);

  return {
    update,
    dialog,
    setDialog,
    busy,
    status,
    releaseNotes,
    downloadSummary,
    check,
    confirmDownload,
    confirmInstall,
    confirmPermission,
  };
}

export type UpdateFlow = ReturnType<typeof useUpdateFlow>;
