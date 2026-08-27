import {NativeModules} from 'react-native';
import {installEnvironment} from '../services/environmentService';

export type StartupStage = 'container' | 'proot' | 'environment';

export type StartupProgress = {
  stage: StartupStage;
  message: string;
  progress: number;
  logs: string[];
};

const maxLogLines = 8;
const startupLogLines: string[] = [];

const clipUiLine = (line: string) => (line.length > 180 ? `${line.slice(0, 180)}…` : line);

const now = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** 返回本次启动的完整操作日志（带时间戳），用于失败后保存到文件。 */
export function getStartupLog(): string {
  return startupLogLines.join('\n');
}

type StartupModule = {
  initialize: () => Promise<string>;
  start: () => Promise<string>;
};

const proot = NativeModules.KarinProot as StartupModule | undefined;

/** Runs boot work behind the splash screen. Native work can be added without changing the UI. */
export async function runStartupTasks(onProgress: (progress: StartupProgress) => void) {
  if (!proot) throw new Error('KarinProot 原生模块不可用');
  if (typeof proot.initialize !== 'function' || typeof proot.start !== 'function') {
    throw new Error('KarinProot 原生接口不完整，请重新编译安装应用');
  }
  startupLogLines.length = 0;
  const logs: string[] = [];
  let phase = '正在检查运行环境';
  const pushLog = (line: string) => {
    if (!line.trim()) return;
    startupLogLines.push(`[${now()}] ${line}`);
    logs.push(clipUiLine(line));
    if (logs.length > maxLogLines) logs.splice(0, logs.length - maxLogLines);
  };
  const pushStage = (message: string) => {
    startupLogLines.push(`[${now()}] === ${message}`);
  };
  const emit = (stage: StartupStage, message: string, progress: number) => {
    onProgress({stage, message, progress, logs: [...logs]});
  };

  pushStage('初始化 proot 容器');
  emit('container', '正在初始化容器', 0.12);
  await proot.initialize();
  pushStage('容器初始化完成');
  emit('container', '容器初始化完成', 0.68);

  pushStage('启动 proot 容器');
  emit('proot', '正在启动容器', 0.78);
  await proot.start();
  pushStage('proot 容器已运行');

  pushStage('检查运行环境');
  emit('environment', '正在检查运行环境', 0.84);
  await installEnvironment({
    onPhase: value => { phase = value; emit('environment', phase, 0.92); },
    onLog: line => { pushLog(line); emit('environment', phase, 0.92); },
  });
  emit('environment', '运行环境准备完成', 1);
  emit('proot', 'proot 容器已运行', 1);
}
