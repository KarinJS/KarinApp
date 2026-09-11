import {NativeModules} from 'react-native';
import {installEnvironment, reinstallKarinProject} from '../services/environmentService';

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
  reset: () => Promise<string>;
};

const proot = NativeModules.KarinProot as StartupModule | undefined;

type ProgressToolkit = {
  pushLog: (line: string) => void;
  pushStage: (message: string) => void;
  emit: (stage: StartupStage, message: string, progress: number) => void;
};

/** 构建一套进度回调：日志同时写入完整启动日志（带时间戳）和界面最近几行日志。 */
function createProgressToolkit(onProgress: (progress: StartupProgress) => void): ProgressToolkit {
  const logs: string[] = [];
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
  return {pushLog, pushStage, emit};
}

/** 初始化并启动 proot 容器；原生侧已在运行时会直接返回，可安全重复调用。 */
async function ensureContainerRunning({pushStage, emit}: ProgressToolkit) {
  if (!proot) throw new Error('KarinProot 原生模块不可用');
  if (typeof proot.initialize !== 'function' || typeof proot.start !== 'function') {
    throw new Error('KarinProot 原生接口不完整，请重新编译安装应用');
  }

  pushStage('初始化 proot 容器');
  emit('container', '正在初始化容器', 0.12);
  await proot.initialize();
  pushStage('容器初始化完成');
  emit('container', '容器初始化完成', 0.68);

  pushStage('启动 proot 容器');
  emit('proot', '正在启动容器', 0.78);
  await proot.start();
  pushStage('proot 容器已运行');
}

/** 在已运行的容器内准备 Karin 运行环境（幂等）。 */
async function installEnvironmentWithProgress({pushStage, pushLog, emit}: ProgressToolkit) {
  let phase = '正在准备运行环境';
  pushStage(phase);
  emit('environment', phase, 0.84);
  await installEnvironment({
    onPhase: value => { phase = value; emit('environment', phase, 0.92); },
    onLog: line => { pushLog(line); emit('environment', phase, 0.92); },
  });
  emit('environment', '运行环境准备完成', 1);
  emit('proot', 'proot 容器已运行', 1);
}

/** Runs boot work behind the splash screen. Native work can be added without changing the UI. */
export async function runStartupTasks(onProgress: (progress: StartupProgress) => void) {
  startupLogLines.length = 0;
  const toolkit = createProgressToolkit(onProgress);
  await ensureContainerRunning(toolkit);
  await installEnvironmentWithProgress(toolkit);
}

/** 重置容器环境：还原 rootfs 后重新走容器启动与环境安装流程。 */
export async function resetContainerEnvironment(onProgress: (progress: StartupProgress) => void) {
  if (!proot) throw new Error('KarinProot 原生模块不可用');
  startupLogLines.length = 0;
  const toolkit = createProgressToolkit(onProgress);
  toolkit.pushStage('重置容器环境');
  toolkit.emit('container', '正在重置容器', 0.06);
  await proot.reset();
  toolkit.pushStage('容器重置完成');
  await ensureContainerRunning(toolkit);
  await installEnvironmentWithProgress(toolkit);
}

/** 重置 Karin 项目：清空 /root/karin 后重新安装并初始化 node-karin（容器需处于运行状态）。 */
export async function resetKarinProjectEnvironment(onProgress: (progress: StartupProgress) => void) {
  startupLogLines.length = 0;
  const toolkit = createProgressToolkit(onProgress);
  toolkit.pushStage('重置 Karin 项目');
  let phase = '正在重置 Karin 项目';
  toolkit.emit('environment', phase, 0.3);
  await reinstallKarinProject({
    onPhase: value => { phase = value; toolkit.emit('environment', value, 0.7); },
    onLog: line => { toolkit.pushLog(line); toolkit.emit('environment', phase, 0.7); },
  });
  toolkit.emit('environment', '运行环境准备完成', 1);
}
