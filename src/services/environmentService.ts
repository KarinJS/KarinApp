import {executeAndCollect, executeStreaming} from './prootController';

export type EnvironmentVersions = {node: string[]; npm: string[]; pnpm: string[]; karin: string[]};

export type EnvironmentInstallHandlers = {
  onPhase: (phase: string) => void;
  onLog: (line: string) => void;
};

type InstalledVersions = {node: string; npm: string; pnpm: string; karin: string};
type PhaseHandler = (phase: string) => void;
type LogHandler = (line: string) => void;

const PROBE_TIMEOUT_MS = 6_000;
const INSTALL_STEP_TIMEOUT_MS = 15 * 60 * 1000;
const PACKAGE_STEP_TIMEOUT_MS = 5 * 60 * 1000;

const NODE_TARGET_MAJOR = 24;
const PNPM_TARGET_PREFIX = '9.';

const NODE_INSTALL_COMMAND = [
  'apt-get update',
  'apt-get install -y curl xz-utils',
  'curl -fsSL https://nodejs.org/dist/v24.0.0/node-v24.0.0-linux-arm64.tar.xz -o /tmp/node.tar.xz',
  'tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1',
  'rm -f /tmp/node.tar.xz',
].join(' && ');
const NPM_INSTALL_COMMAND = 'npm install -g npm@latest';
const PNPM_INSTALL_COMMAND = 'npm install -g pnpm@9';
const KARIN_PREPARE_COMMAND = [
  'mkdir -p /root/karin',
  'test -f /root/karin/node_modules/node-karin/package.json || (cd /root/karin && pnpm i node-karin@latest && npx node-karin init)',
].join(' && ');

export async function inspectEnvironment(): Promise<InstalledVersions> {
  const probe = async (command: string) => {
    try {
      const output = await executeAndCollect(command, PROBE_TIMEOUT_MS);
      return output.trim().replace(/^v/, '');
    } catch {
      return '';
    }
  };
  const [node, npm, pnpm, karin] = await Promise.all([
    probe('node --version 2>/dev/null'),
    probe('npm --version 2>/dev/null'),
    probe('pnpm --version 2>/dev/null'),
    probe("node -p \"require('/root/karin/node_modules/node-karin/package.json').version\" 2>/dev/null"),
  ]);
  return {node, npm, pnpm, karin};
}

const clipLogLine = (line: string) => (line.length > 180 ? `${line.slice(0, 180)}…` : line);

async function runStreaming(command: string, onLog: LogHandler, timeoutMs: number) {
  onLog(`$ ${command}`);
  await executeStreaming(
    command,
    line => {
      const clipped = clipLogLine(line);
      if (clipped.trim()) {
        onLog(clipped);
      }
    },
    timeoutMs,
  );
}

const nodeMajor = (version: string) => Number(version.split('.')[0]);

/** 检查 Node.js；缺失或低于目标版本时自动安装，并返回刷新后的环境信息。 */
async function ensureNode(current: InstalledVersions, onPhase: PhaseHandler, onLog: LogHandler): Promise<InstalledVersions> {
  if (current.node && nodeMajor(current.node) >= NODE_TARGET_MAJOR) {
    onLog(`node --version -> v${current.node}`);
    return current;
  }
  onPhase(`正在安装 Node.js (v${NODE_TARGET_MAJOR}.0.0)`);
  await runStreaming(NODE_INSTALL_COMMAND, onLog, INSTALL_STEP_TIMEOUT_MS);
  onPhase('Node.js 安装完成');
  return inspectEnvironment();
}

/** 检查 npm；缺失时自动安装，并返回刷新后的环境信息。 */
async function ensureNpm(current: InstalledVersions, onPhase: PhaseHandler, onLog: LogHandler): Promise<InstalledVersions> {
  if (current.npm) {
    onLog(`npm --version -> ${current.npm}`);
    return current;
  }
  onPhase('正在安装 npm');
  await runStreaming(NPM_INSTALL_COMMAND, onLog, PACKAGE_STEP_TIMEOUT_MS);
  onPhase('npm 安装完成');
  return inspectEnvironment();
}

/** 检查 pnpm；缺失或不是目标大版本时自动安装。 */
async function ensurePnpm(current: InstalledVersions, onPhase: PhaseHandler, onLog: LogHandler): Promise<InstalledVersions> {
  if (current.pnpm && current.pnpm.startsWith(PNPM_TARGET_PREFIX)) {
    onLog(`pnpm --version -> ${current.pnpm}`);
    return current;
  }
  onPhase('正在安装 pnpm');
  await runStreaming(PNPM_INSTALL_COMMAND, onLog, PACKAGE_STEP_TIMEOUT_MS);
  onPhase('pnpm 安装完成');
  return current;
}

/** 准备 /root/karin 目录与 node-karin 运行时。 */
async function prepareKarin(onPhase: PhaseHandler, onLog: LogHandler) {
  onPhase('正在准备 Karin');
  await runStreaming(KARIN_PREPARE_COMMAND, onLog, PACKAGE_STEP_TIMEOUT_MS);
  onPhase('运行环境准备完成');
}

export async function installEnvironment({onPhase, onLog}: EnvironmentInstallHandlers) {
  let current = await inspectEnvironment();
  current = await ensureNode(current, onPhase, onLog);
  current = await ensureNpm(current, onPhase, onLog);
  await ensurePnpm(current, onPhase, onLog);
  await prepareKarin(onPhase, onLog);
  const final = await inspectEnvironment();
  onLog(`Node.js ${final.node || '-'} / npm ${final.npm || '-'} / pnpm ${final.pnpm || '-'} / node-karin ${final.karin || '-'}`);
}
