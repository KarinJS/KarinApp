import {useCallback, useMemo, useRef, useState} from 'react';

export type PluginTaskStatus = 'running' | 'warning' | 'completed' | 'failed' | 'cancelled';
export type PluginTaskKind = 'install' | 'remove' | 'version';
export type PluginTaskTarget = {key: string; label: string; type?: 'npm' | 'git' | 'app'};
export type PluginTaskWarning = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
};
export type PluginTask = {
  id: string;
  name: string;
  /** 按安装位置关联条目，同名 npm 与目录插件各自显示任务状态。 */
  target?: PluginTaskTarget;
  kind: PluginTaskKind;
  status: PluginTaskStatus;
  startedAt: number;
  endedAt?: number;
  logs: string[];
  warning?: PluginTaskWarning;
  /** 等待底层进程退出或原生导入清理完成期间，仍按进行中处理。 */
  cancelling?: boolean;
};

export type PluginTaskRunner = {
  signal: AbortSignal;
  onLog: (line: string) => void;
  onWarning: (warning: string | PluginTaskWarning) => Promise<boolean>;
  cancel: () => void;
  setName: (name: string) => void;
  setTarget: (target: PluginTaskTarget) => void;
};

type PendingWarning = {
  warning: PluginTaskWarning;
  resolve: (accepted: boolean) => void;
  open: boolean;
};

/** 当前需要由任务面板显示的警告确认。弹窗由页面渲染，避免任务 hook 直接调用原生 Alert。 */
export type PluginTaskWarningDialog = {
  taskId: string;
  warning: PluginTaskWarning;
};

const addLog = (logs: string[], line: string) => [...logs, line].slice(-2000);
let nextTaskNumber = 0;
const taskId = () => `plugin-task-${Date.now()}-${++nextTaskNumber}`;
const isNpmTarget = (target?: PluginTaskTarget) => target?.type === 'npm' || (!target?.type && target?.key.startsWith('npm:') === true);

/**
 * 每次安装都有独立记录；警告会暂停任务，点击警告后选择是否继续。
 * 终止仅请求底层取消，等实际退出、清理完成后才标记为已终止。
 */
export function usePluginTasks() {
  const [tasks, setTasks] = useState<Record<string, PluginTask>>({});
  const [warningDialog, setWarningDialog] = useState<PluginTaskWarningDialog | null>(null);
  const [completedRevision, setCompletedRevision] = useState(0);
  const controllers = useRef<Record<string, AbortController>>({});
  const activeTargets = useRef<Record<string, PluginTaskTarget | undefined>>({});
  const warnings = useRef<Record<string, PendingWarning>>({});
  const warningDialogRef = useRef<PluginTaskWarningDialog | null>(null);

  const closeWarning = useCallback((id: string) => {
    if (warningDialogRef.current?.taskId !== id) return;
    warningDialogRef.current = null;
    setWarningDialog(current => (current?.taskId === id ? null : current));
  }, []);

  const updateTask = useCallback((id: string, updater: (task: PluginTask) => PluginTask) => {
    setTasks(current => (current[id] ? {...current, [id]: updater(current[id])} : current));
  }, []);

  const appendLog = useCallback((id: string, line: string) => {
    if (!line) return;
    updateTask(id, task => ({...task, logs: addLog(task.logs, line)}));
  }, [updateTask]);

  const runTask = useCallback(async (
    name: string,
    kind: PluginTaskKind,
    operation: (runner: PluginTaskRunner) => Promise<void>,
    target?: PluginTaskTarget,
  ) => {
    // 只有 npm 任务共用 pnpm 写锁；同一安装位置仍复用任务，避免同时覆盖/删除。
    // 用同步 ref 判断，快速连点与取消清理期间也不能绕过互斥。
    const activeId = Object.keys(controllers.current).find(active => {
      const activeTarget = activeTargets.current[active];
      return (target !== undefined && activeTarget?.key === target.key)
        || (isNpmTarget(target) && isNpmTarget(activeTarget));
    });
    if (activeId) return activeId;
    const id = taskId();
    const controller = new AbortController();
    controllers.current[id] = controller;
    activeTargets.current[id] = target;
    const startedAt = Date.now();
    const action = kind === 'version' ? '切换版本' : kind === 'remove' ? '卸载' : '安装';
    setTasks(current => ({
      ...current,
      [id]: {id, name, target, kind, status: 'running', startedAt, logs: [`开始${action}：${name}`]},
    }));
    const onLog = (line: string) => appendLog(id, line);
    const abort = () => {
      const pending = warnings.current[id];
      delete warnings.current[id];
      pending?.resolve(false);
      closeWarning(id);
      updateTask(id, task => ({
        ...task,
        status: 'running',
        cancelling: true,
        warning: undefined,
        logs: addLog(task.logs, '正在终止任务，等待清理完成…'),
      }));
    };
    controller.signal.addEventListener('abort', abort, {once: true});

    const onWarning = (value: string | PluginTaskWarning): Promise<boolean> => {
      // 原生回调或退出中的进程仍可能晚到一条警告，不能重新挂起已取消的任务。
      if (controller.signal.aborted || controllers.current[id] !== controller) return Promise.resolve(false);
      const warning: PluginTaskWarning = typeof value === 'string' ? {message: value} : value;
      return new Promise<boolean>(resolve => {
        warnings.current[id] = {warning, resolve, open: false};
        updateTask(id, task => ({
          ...task,
          status: 'warning',
          warning,
          logs: addLog(task.logs, `警告：${warning.message} 请点击任务的「警告」标签处理。`),
        }));
      });
    };

    const finish = (failed = false, error?: unknown) => {
      const cancelled = controller.signal.aborted;
      const message = error instanceof Error ? error.message : error === undefined ? '' : String(error);
      updateTask(id, task => ({
        ...task,
        status: cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
        endedAt: Date.now(),
        warning: undefined,
        cancelling: false,
        logs: addLog(task.logs, cancelled ? '任务已终止' : failed ? `任务失败：${message || '未知错误'}` : '任务已完成'),
      }));
    };

    try {
      await operation({
        signal: controller.signal,
        onLog,
        onWarning,
        cancel: () => controller.abort(),
        setName: nextName => {
          if (nextName.trim()) updateTask(id, task => ({...task, name: nextName.trim()}));
        },
        setTarget: nextTarget => {
          activeTargets.current[id] = nextTarget;
          updateTask(id, task => ({...task, target: nextTarget}));
        },
      });
      finish();
    } catch (error) {
      finish(true, error);
    } finally {
      controller.signal.removeEventListener('abort', abort);
      delete controllers.current[id];
      delete activeTargets.current[id];
      const pending = warnings.current[id];
      delete warnings.current[id];
      pending?.resolve(false);
      closeWarning(id);
      setCompletedRevision(current => current + 1);
    }
    return id;
  }, [appendLog, closeWarning, updateTask]);

  const stopTask = useCallback((id: string) => {
    const controller = controllers.current[id];
    if (!controller || controller.signal.aborted) return;
    controller.abort();
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks(current => {
      if (!['completed', 'cancelled'].includes(current[id]?.status ?? '')) return current;
      const next = {...current};
      delete next[id];
      return next;
    });
  }, []);

  const showWarning = useCallback((id: string) => {
    const pending = warnings.current[id];
    const controller = controllers.current[id];
    if (!pending || pending.open || warningDialogRef.current || !controller || controller.signal.aborted) return;
    const warning = pending.warning;
    pending.open = true;
    warningDialogRef.current = {taskId: id, warning};
    setWarningDialog({taskId: id, warning});
  }, []);

  const resolveWarning = useCallback((id: string, accepted: boolean) => {
    const pending = warnings.current[id];
    const controller = controllers.current[id];
    const dialog = warningDialogRef.current;
    // 绑定当前弹窗对应的 PendingWarning，避免旧弹窗回调误处理同一任务后续的新警告。
    if (!pending || pending.open === false || dialog?.taskId !== id || dialog.warning !== pending.warning || warningDialog?.taskId !== id || warningDialog.warning !== pending.warning || !controller || controller.signal.aborted) {
      return;
    }
    const choose = (confirmed: boolean) => {
      // 弹窗可能在终止之后才收到点击；只能处理当时的这一条警告。
      if (warnings.current[id] !== pending || controllers.current[id] !== controller || controller.signal.aborted) return;
      delete warnings.current[id];
      if (confirmed) {
        updateTask(id, current => ({
          ...current,
          status: 'running',
          warning: undefined,
          logs: addLog(current.logs, '已确认，继续执行'),
        }));
      } else {
        appendLog(id, '已选择取消');
        controller.abort();
      }
      pending.resolve(confirmed);
    };
    closeWarning(id);
    choose(accepted);
  }, [appendLog, closeWarning, updateTask, warningDialog]);

  const taskList = useMemo(() => Object.values(tasks).sort((left, right) => right.startedAt - left.startedAt), [tasks]);
  const running = useMemo(() => taskList.some(task => task.status === 'running' || task.status === 'warning'), [taskList]);
  const npmBusy = useMemo(() => taskList.some(task => isNpmTarget(task.target) && (task.status === 'running' || task.status === 'warning')), [taskList]);

  return {
    tasks,
    taskList,
    running,
    npmBusy,
    completedRevision,
    runTask,
    stopTask,
    removeTask,
    showWarning,
    resolveWarning,
    warningDialog,
    updateTask,
    appendLog,
  };
}
