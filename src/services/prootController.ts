import {DeviceEventEmitter, EventSubscription, NativeModules} from 'react-native';

type ProotCommandEvent = {
  commandId: string;
  stream: 'stdout' | 'stderr' | 'exit';
  data: string;
  exitCode?: number;
};

type NativeProotController = {
  start: () => Promise<string>;
  stop: (force: boolean) => Promise<string>;
  status: () => Promise<string>;
  execute: (command: string, commandId: string, interactive: boolean) => Promise<string>;
  kill: (commandId: string) => Promise<string>;
  write: (commandId: string, data: string) => Promise<string>;
};

const native = NativeModules.KarinProot as NativeProotController;

export const prootController = {
  start: () => native.start(),
  stop: (force = false) => native.stop(force),
  status: () => native.status(),
  execute: (command: string, commandId = `${Date.now()}`, interactive = false) =>
    native.execute(command, commandId, interactive),
  /** 停止命令：守护进程先给进程组 SIGTERM 让它收尾，宽限期（10 秒）过后仍在的才 SIGKILL。 */
  kill: (commandId: string) => native.kill(commandId),
  /** 向以 interactive 方式启动的命令写入 stdin；仅该命令能收到。 */
  write: (commandId: string, data: string) => native.write(commandId, data),
  subscribe(listener: (event: ProotCommandEvent) => void): EventSubscription {
    return DeviceEventEmitter.addListener('KarinProotCommand', listener);
  },
};

const ERROR_TAIL_LINES = 40;
const ERROR_TAIL_CHARS = 1200;

function clipTail(text: string, maxLines: number, maxChars: number): string {
  const tail = text.trim().split('\n').slice(-maxLines).join('\n');
  return tail.length > maxChars ? '…' + tail.slice(-maxChars) : tail;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** 流式执行容器内命令；修改文件的任务可等待取消后的退出事件，避免清理完成前释放任务锁。 */
export function executeStreaming(
  command: string,
  onLine: (line: string) => void,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
  options: {waitForExitOnAbort?: boolean} = {},
): Promise<string> {
  const commandId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('任务已终止'));
      return;
    }
    const state = {
      output: '',
      settled: false,
      terminationError: undefined as Error | undefined,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      subscription: undefined as EventSubscription | undefined,
      abortListener: undefined as (() => void) | undefined,
    };
    const finish = (callback: () => void) => {
      if (state.settled) return;
      state.settled = true;
      if (state.timer) clearTimeout(state.timer);
      if (signal && state.abortListener) signal.removeEventListener('abort', state.abortListener);
      state.subscription?.remove();
      callback();
    };
    const terminate = (message: string) => {
      if (state.settled || state.terminationError) return;
      if (!options.waitForExitOnAbort) {
        finish(() => {
          prootController.kill(commandId).catch(() => {});
          reject(new Error(message));
        });
        return;
      }
      state.terminationError = new Error(message);
      // kill 的 Promise 只表示已发出请求；真正退出以前保留事件监听与调用方的任务锁。
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      try {
        prootController.kill(commandId).catch(error => finish(() => reject(error)));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    if (signal) {
      state.abortListener = () => terminate('任务已终止');
      signal.addEventListener('abort', state.abortListener, {once: true});
    }
    state.subscription = prootController.subscribe(event => {
      if (event.commandId !== commandId) return;
      if (event.stream === 'stdout' || event.stream === 'stderr') {
        if (!event.data) return;
        state.output += `${event.data}\n`;
        try { onLine(event.data); } catch {}
      }
      if (event.stream === 'exit') {
        finish(() => {
          if (state.terminationError) reject(state.terminationError);
          else if (event.exitCode === 0) resolve(state.output.trim());
          else reject(new Error(`命令退出码 ${event.exitCode}${state.output.trim() ? `\n${clipTail(state.output, ERROR_TAIL_LINES, ERROR_TAIL_CHARS)}` : ''}`));
        });
      }
    });
    state.timer = setTimeout(() => {
      terminate(`命令执行超时（${timeoutMs}ms），已终止容器内进程`);
    }, timeoutMs);
    try {
      prootController.execute(command, commandId).catch(error => finish(() => reject(error)));
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

export function executeAndCollect(command: string, timeoutMs?: number): Promise<string> {
  return executeStreaming(command, () => {}, timeoutMs);
}
