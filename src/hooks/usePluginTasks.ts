import {useCallback, useMemo, useRef, useState} from 'react';
import {Alert} from 'react-native';

export type PluginTaskStatus = 'running' | 'warning' | 'completed' | 'failed' | 'cancelled';
export type PluginTaskKind = 'install' | 'remove';
export type PluginTaskWarning = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
};
export type PluginTask = {
  id: string;
  name: string;
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
};

type PendingWarning = {
  warning: PluginTaskWarning;
  resolve: (accepted: boolean) => void;
  open: boolean;
};

const addLog = (logs: string[], line: string) => [...logs, line].slice(-2000);
let nextTaskNumber = 0;
const taskId = () => `plugin-task-${Date.now()}-${++nextTaskNumber}`;

/**
 * 每次安装都有独立记录；警告会暂停任务，点击警告后选择是否继续。
 * 终止仅请求底层取消，等实际退出、清理完成后才标记为已终止。
 */
export function usePluginTasks() {
  const [tasks, setTasks] = useState<Record<string, PluginTask>>({});
  const controllers = useRef<Record<string, AbortController>>({});
  const warnings = useRef<Record<string, PendingWarning>>({});

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
  ) => {
    // 禁止绕过页面按钮触发并发写入；清理尚未完成时也复用当前任务。
    const activeId = Object.keys(controllers.current)[0];
    if (activeId) return activeId;
    const id = taskId();
    const controller = new AbortController();
    controllers.current[id] = controller;
    const startedAt = Date.now();
    setTasks(current => ({
      ...current,
      [id]: {id, name, kind, status: 'running', startedAt, logs: [`开始${kind === 'remove' ? '卸载' : '安装'}：${name}`]},
    }));
    const onLog = (line: string) => appendLog(id, line);
    const abort = () => {
      const pending = warnings.current[id];
      delete warnings.current[id];
      pending?.resolve(false);
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
      });
      finish();
    } catch (error) {
      finish(true, error);
    } finally {
      controller.signal.removeEventListener('abort', abort);
      delete controllers.current[id];
      const pending = warnings.current[id];
      delete warnings.current[id];
      pending?.resolve(false);
    }
    return id;
  }, [appendLog, updateTask]);

  const stopTask = useCallback((id: string) => {
    const controller = controllers.current[id];
    if (!controller || controller.signal.aborted) return;
    controller.abort();
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks(current => {
      if (current[id]?.status !== 'completed') return current;
      const next = {...current};
      delete next[id];
      return next;
    });
  }, []);

  const showWarning = useCallback((id: string) => {
    const pending = warnings.current[id];
    const controller = controllers.current[id];
    if (!pending || pending.open || !controller || controller.signal.aborted) return;
    const warning = pending.warning;
    pending.open = true;
    const choose = (accepted: boolean) => {
      // 弹窗可能在终止之后才收到点击；只能处理当时的这一条警告。
      if (warnings.current[id] !== pending || controllers.current[id] !== controller || controller.signal.aborted) return;
      delete warnings.current[id];
      if (accepted) {
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
      pending.resolve(accepted);
    };
    Alert.alert(
      warning.title ?? '安装警告',
      warning.message,
      [
        {text: warning.cancelLabel ?? '否', style: 'cancel', onPress: () => choose(false)},
        {text: warning.confirmLabel ?? '是', style: 'destructive', onPress: () => choose(true)},
      ],
      {cancelable: false},
    );
  }, [appendLog, updateTask]);

  const taskList = useMemo(() => Object.values(tasks).sort((left, right) => right.startedAt - left.startedAt), [tasks]);
  const running = useMemo(() => taskList.some(task => task.status === 'running' || task.status === 'warning'), [taskList]);

  return {tasks, taskList, running, runTask, stopTask, removeTask, showWarning, updateTask, appendLog};
}
