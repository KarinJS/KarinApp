import {EventSubscription} from 'react-native';
import {executeAndCollect, prootController} from './prootController';
import {KarinLogLine} from './karinLogService';

/** log4js dateFile 的落盘目录（node-karin 的 karinPathLogs），文件名 logger.<日期>.log。 */
const LOG_DIR = '/root/karin/@karinjs/logs';
/** 单次加载/跟随的最大行数，与运行日志的环形缓冲一致。 */
const TAIL_LINES = 2000;
/** log4js pattern "[%d{hh:mm:ss.SSS}][%4.4p] %m" 产生的行前缀。 */
const FILE_LINE_PATTERN = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\]\[([A-Z]{3,4})\]\s?([\s\S]*)$/;
const FILE_NAME_PATTERN = /^logger\.(\d{4}-\d{2}-\d{2})\.log$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 级别（%4.4p 截到 4 位）对应的前缀 ANSI 色号，与 karin web 端实时日志页一致。 */
const LEVEL_FG: Record<string, number> = {TRAC: 34, DEBU: 36, INFO: 32, WARN: 33, ERRO: 31, FATA: 35, MARK: 90};

/** 设备本地日期（时区已同步进容器，两边一致）。 */
export function todayLogDate(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function logFilePath(date: string): string {
  if (!DATE_PATTERN.test(date)) throw new Error('非法日期');
  return `${LOG_DIR}/logger.${date}.log`;
}

/** 列出有日志文件的日子，新在前；目录不存在（Karin 从未运行过）返回空。 */
export async function listLogDates(): Promise<string[]> {
  let output: string;
  try {
    output = await executeAndCollect(`ls -1 ${LOG_DIR} 2>/dev/null`, 15_000);
  } catch {
    return [];
  }
  const dates = output
    .split('\n')
    .map(line => FILE_NAME_PATTERN.exec(line.trim())?.[1])
    .filter((date): date is string => !!date);
  return dates.sort((a, b) => b.localeCompare(a));
}

/** 读某一天日志的末尾若干行（纯文本，文件里没有 ANSI 色）。 */
export async function readLogLines(date: string): Promise<string[]> {
  const output = await executeAndCollect(`tail -n ${TAIL_LINES} '${logFilePath(date)}' 2>/dev/null`, 30_000);
  if (!output.trim()) return [];
  return output.split('\n');
}

/**
 * 跟随一天的日志文件（tail -F）：先回放末尾若干行，再有新行实时回调。
 * 文件还不存在时 tail 静默等待，Karin 首次启动写日志后会自动跟上。
 */
export function startLogTail(date: string, onLine: (line: string) => void): () => void {
  const commandId = `karin-logtail-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // 输出帧可能在行中间切开，carry 把残行攒到下一个帧再拼出来。
  let carry = '';
  const subscription: EventSubscription = prootController.subscribe(event => {
    if (event.commandId !== commandId) return;
    if (event.stream === 'stdout' && event.data) {
      carry += event.data;
      const parts = carry.split('\n');
      carry = parts.pop() ?? '';
      parts.forEach(onLine);
    }
    if (event.stream === 'exit' && carry) {
      onLine(carry);
      carry = '';
    }
  });
  prootController.execute(`tail -n ${TAIL_LINES} -F '${logFilePath(date)}' 2>/dev/null`, commandId).catch(() => {
    // 容器未运行时 execute 直接失败：没有实时日志可跟，订阅也不会再收到事件
  });
  return () => {
    subscription.remove();
    prootController.kill(commandId).catch(() => {});
  };
}

/**
 * 把纯文本日志行格式化成渲染行：文件里没有颜色码，按级别给 [时间][级别] 前缀
 * 重新上色（与 karin web 端历史日志同一思路），正文保持默认色。
 */
export function formatLogFileLine(raw: string, id: number): KarinLogLine | null {
  const line = raw.replace(/\s+$/, '');
  if (!line) return null;
  const match = FILE_LINE_PATTERN.exec(line);
  if (!match) {
    // 多行堆栈的续行等不符合前缀格式的行原样显示
    return {id, stream: 'stdout', segments: [{text: line}]};
  }
  const [, time, level, message] = match;
  const fg = LEVEL_FG[level];
  const segments = [{text: `[${time}][${level}]`, ...(fg === undefined ? {} : {fg, bold: true})}];
  if (message) segments.push({text: message});
  return {id, stream: 'stdout', segments};
}
