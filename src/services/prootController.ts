import {DeviceEventEmitter, EventSubscription, NativeModules, } from 'react-native';

export type ProotCommandEvent = {
  commandId: string;
  stream: 'stdout' | 'stderr' | 'exit';
  data: string;
  exitCode?: number;
};

type NativeProotController = {
  start: () => Promise<string>;
  stop: (force: boolean) => Promise<string>;
  status: () => Promise<string>;
  execute: (command: string, commandId: string) => Promise<string>;
  kill: (commandId: string) => Promise<string>;
};

const native = NativeModules.KarinProot as NativeProotController;

export const prootController = {
  start: () => native.start(),
  stop: (force = false) => native.stop(force),
  status: () => native.status(),
  execute: (command: string, commandId = `${Date.now()}`) => native.execute(command, commandId),
  kill: (commandId: string) => native.kill(commandId),
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

/** 流式执行容器内命令：每行输出回调 onLine，最后返回完整输出；超时则 kill 容器内进程并拒绝。 */
export function executeStreaming(
  command: string,
  onLine: (line: string) => void,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const commandId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const state = {
      output: '',
      settled: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      subscription: undefined as EventSubscription | undefined,
    };
    const finish = (callback: () => void) => {
      if (state.settled) return;
      state.settled = true;
      if (state.timer) clearTimeout(state.timer);
      state.subscription?.remove();
      callback();
    };
    state.subscription = prootController.subscribe(event => {
      if (event.commandId !== commandId) return;
      if (event.stream === 'stdout' || event.stream === 'stderr') {
        if (!event.data) return;
        state.output += `${event.data}\n`;
        try { onLine(event.data); } catch {}
      }
      if (event.stream === 'exit') {
        finish(() => {
          if (event.exitCode === 0) resolve(state.output.trim());
          else reject(new Error(`命令退出码 ${event.exitCode}${state.output.trim() ? `\n${clipTail(state.output, ERROR_TAIL_LINES, ERROR_TAIL_CHARS)}` : ''}`));
        });
      }
    });
    state.timer = setTimeout(() => {
      finish(() => {
        prootController.kill(commandId).catch(() => {});
        reject(new Error(`命令执行超时（${timeoutMs}ms），已终止容器内进程`));
      });
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
