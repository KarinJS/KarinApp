import {EventSubscription} from 'react-native';
import {KARIN_COMMAND_ID} from './karinService';
import {prootController} from './prootController';

export type KarinLogStream = 'stdout' | 'stderr' | 'system' | 'input';

export type KarinLogLine = {
  id: number;
  stream: KarinLogStream;
  text: string;
};

/** 内存里保留的最大行数：够回看当前运行，又不至于拖慢列表。 */
const MAX_LINES = 2000;
/** 高频日志合并通知，避免每一行都触发一次 React 渲染。 */
const NOTIFY_INTERVAL_MS = 120;
/** 日志里的 ANSI 控制码（颜色/清屏）在纯文本视图里没有意义，统一剥离。 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]|\u001B\][^\u0007]*\u0007/g;

let lines: KarinLogLine[] = [];
let nextId = 1;
let capture: EventSubscription | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const scheduleNotify = () => {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    listeners.forEach(listener => listener());
  }, NOTIFY_INTERVAL_MS);
};

/** 追加一行日志；统一剥掉 ANSI 控制码并裁剪历史长度。 */
export function appendKarinLog(text: string, stream: KarinLogStream = 'system') {
  const clean = text.replace(ANSI_PATTERN, '').replace(/\r/g, '').trimEnd();
  if (!clean) return;
  lines.push({id: nextId++, stream, text: clean});
  if (lines.length > MAX_LINES) lines = lines.slice(lines.length - MAX_LINES);
  scheduleNotify();
}

/**
 * 捕获 Karin 运行日志；幂等，App 启动时调用一次，所以打开日志页之前的历史也在。
 * 常驻进程的 stdout/stderr 每行一个事件，进程退出时补一条分隔提示。
 */
export function startKarinLogCapture() {
  if (capture) return;
  capture = prootController.subscribe(event => {
    if (event.commandId !== KARIN_COMMAND_ID) return;
    if (event.stream === 'exit') {
      appendKarinLog(`=== Karin 已退出（退出码 ${event.exitCode ?? '未知'}）`);
      return;
    }
    const stream: KarinLogStream = event.stream === 'stderr' ? 'stderr' : 'stdout';
    event.data.split('\n').forEach(part => appendKarinLog(part, stream));
  });
}

/** 订阅日志变化；回调触发时用 getKarinLogLines() 重新读取最新内容。 */
export function subscribeKarinLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getKarinLogLines(): KarinLogLine[] {
  return lines;
}

export function clearKarinLog() {
  lines = [];
  scheduleNotify();
}
