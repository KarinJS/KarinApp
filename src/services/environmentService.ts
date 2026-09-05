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
const KARIN_DIR = '/root/karin';
/** node-karin init 生成的标志文件；init 内部的 pnpm install -f 会重建 node_modules，绝不能重复执行。 */
const KARIN_INIT_MARKERS = [`${KARIN_DIR}/index.mjs`, `${KARIN_DIR}/.env`];

const KARIN_INSTALL_COMMAND = [
  `mkdir -p ${KARIN_DIR}`,
  `cd ${KARIN_DIR}`,
  'if test -f pnpm-workspace.yaml; then pnpm -w i node-karin@latest; else pnpm i node-karin@latest; fi',
].join(' && ');
const KARIN_INIT_COMMAND = `cd ${KARIN_DIR} && npx node-karin init`;

/** 在容器内执行 shell 检测命令，退出码非 0 视为条件不满足。 */
async function checkShell(command: string): Promise<boolean> {
  try {
    await executeAndCollect(command, PROBE_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

const isKarinInstalled = () => checkShell(`test -f ${KARIN_DIR}/node_modules/node-karin/package.json`);
const isKarinInitialized = () => checkShell(KARIN_INIT_MARKERS.map(file => `test -f ${file}`).join(' && '));

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
    probe("node -p 'require(\"/root/karin/node_modules/node-karin/package.json\").version' 2>/dev/null"),
  ]);
  return {node, npm, pnpm, karin};
}

async function runStreaming(command: string, onLog: LogHandler, timeoutMs: number) {
  onLog(`$ ${command}`);
  await executeStreaming(
    command,
    line => {
      if (line.trim()) {
        onLog(line);
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

/**
 * 强制 pnpm 使用复制模式。pnpm 默认把 store 里的文件硬链接进 node_modules，
 * 但 Android 应用私有目录被 SELinux 禁止创建硬链接，proot 的 link2symlink
 * 影子链在强制重装时容易损坏（链接悬空导致已安装的包读不到），因此容器内
 * 一律改为复制。配置写入容器全局 pnpm rc，幂等。
 */
async function ensurePnpmCopyMode(onLog: LogHandler) {
  await executeAndCollect('pnpm config set package-import-method copy', PACKAGE_STEP_TIMEOUT_MS);
  onLog('pnpm 已配置为复制模式（package-import-method=copy）');
}

/** 准备 /root/karin：仅在未安装时安装 node-karin，仅在未初始化时执行 init（两者都可安全重复进入）。 */
async function prepareKarin(current: InstalledVersions, onPhase: PhaseHandler, onLog: LogHandler) {
  if (current.karin || (await isKarinInstalled())) {
    onLog(`node-karin 已安装${current.karin ? `（v${current.karin}）` : ''}，跳过安装`);
  } else {
    if (await checkShell(`test -d ${KARIN_DIR}/node_modules`)) {
      // node-karin 读不到但 node_modules 存在：多为 proot link2symlink 影子链损坏的残留，
      // pnpm 对此会误判 "Already up to date" 而不修复，必须先清理再重装。
      onLog('检测到损坏的 node_modules，清理后重新安装');
      await runStreaming(`rm -rf ${KARIN_DIR}/node_modules`, onLog, PACKAGE_STEP_TIMEOUT_MS);
    }
    onPhase('正在安装 node-karin');
    await runStreaming(KARIN_INSTALL_COMMAND, onLog, INSTALL_STEP_TIMEOUT_MS);
  }
  if (await isKarinInitialized()) {
    onLog('Karin 已初始化，跳过 node-karin init');
  } else {
    onPhase('正在初始化 Karin');
    await runStreaming(KARIN_INIT_COMMAND, onLog, PACKAGE_STEP_TIMEOUT_MS);
  }
  onPhase('运行环境准备完成');
}

const KARIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const VERSION_LIST_TIMEOUT_MS = 30_000;

/** 从 npm registry 查询 node-karin 的全部发布版本，按从新到旧排序。 */
export async function fetchKarinVersions(): Promise<string[]> {
  const output = await executeAndCollect('npm view node-karin versions --json 2>/dev/null', VERSION_LIST_TIMEOUT_MS);
  const parsed: unknown = JSON.parse(output.trim());
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const versions = list.filter((v): v is string => typeof v === 'string' && KARIN_VERSION_PATTERN.test(v));
  if (versions.length === 0) throw new Error('版本列表为空');
  return versions.reverse();
}

/** 在 /root/karin 中切换 node-karin 到指定版本；只安装，不执行 init。 */
export async function switchKarinVersion(version: string, onLog: LogHandler): Promise<void> {
  if (!KARIN_VERSION_PATTERN.test(version)) throw new Error(`非法版本号: ${version}`);
  const command = `cd ${KARIN_DIR} && if test -f pnpm-workspace.yaml; then pnpm -w i node-karin@${version}; else pnpm i node-karin@${version}; fi`;
  await runStreaming(command, onLog, PACKAGE_STEP_TIMEOUT_MS);
}

/**
 * 强制重装 /root/karin 项目：先删除整个项目目录，再重新安装 node-karin 并执行 init。
 * 与 prepareKarin 的“已安装则跳过”不同，这里无条件重装；目录被删后 init 标志
 * 不复存在，init 必然执行（其内部的 pnpm install -f 也只会在此次执行一次）。
 */
export async function reinstallKarinProject({onPhase, onLog}: EnvironmentInstallHandlers): Promise<void> {
  await ensurePnpmCopyMode(onLog);
  onPhase('正在清理 Karin 项目目录');
  await runStreaming(`rm -rf ${KARIN_DIR}`, onLog, PACKAGE_STEP_TIMEOUT_MS);
  onPhase('正在安装 node-karin');
  await runStreaming(KARIN_INSTALL_COMMAND, onLog, INSTALL_STEP_TIMEOUT_MS);
  onPhase('正在初始化 Karin');
  await runStreaming(KARIN_INIT_COMMAND, onLog, PACKAGE_STEP_TIMEOUT_MS);
  onPhase('运行环境准备完成');
}

export async function installEnvironment({onPhase, onLog}: EnvironmentInstallHandlers) {
  let current = await inspectEnvironment();
  current = await ensureNode(current, onPhase, onLog);
  current = await ensureNpm(current, onPhase, onLog);
  await ensurePnpm(current, onPhase, onLog)
  await ensurePnpmCopyMode(onLog);
  await prepareKarin(current, onPhase, onLog);
  const final = await inspectEnvironment();
  onLog(`Node.js ${final.node || '-'} / npm ${final.npm || '-'} / pnpm ${final.pnpm || '-'} / node-karin ${final.karin || '-'}`);
}
