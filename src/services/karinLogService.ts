import {EventSubscription} from 'react-native';
import {AnsiSegment, parseAnsiLine} from '../utils/ansi';
import {KARIN_COMMAND_ID} from './karinService';
import {prootController} from './prootController';

export type KarinLogStream = 'stdout' | 'stderr' | 'system' | 'input';

export type KarinLogLine = {
  id: number;
  stream: KarinLogStream;
  /** 按 ANSI 控制码切好的样式段：颜色/加粗留在样式里，可见文本在 text 里。 */
  segments: AnsiSegment[];
};

/** 内存里保留的最大行数：够回看当前运行，又不至于拖慢列表。 */
const MAX_LINES = 2000;
/** 高频日志合并通知，避免每一行都触发一次 React 渲染。 */
const NOTIFY_INTERVAL_MS = 120;
/** 解析后残留的控制字符（BEL、退格等）在文本视图里没有意义，统一剥离。 */
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

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

/** 追加一行日志；解析出 ANSI 颜色（渲染时再按主题取色）并裁剪历史长度。 */
export function appendKarinLog(text: string, stream: KarinLogStream = 'system') {
  const segments = parseAnsiLine(text.replace(/\r/g, ''))
    .map(segment => ({...segment, text: segment.text.replace(CONTROL_PATTERN, '')}))
    .filter(segment => segment.text.length > 0);
  // 只裁行尾空白，保留 log4js 的缩进等前导空格。
  while (segments.length > 0) {
    const last = segments[segments.length - 1];
    const trimmed = last.text.replace(/\s+$/, '');
    if (trimmed) {
      last.text = trimmed;
      break;
    }
    segments.pop();
  }
  if (segments.length === 0) return;
  lines.push({id: nextId++, stream, segments});
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
