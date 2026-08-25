import {executeAndCollect, executeStreaming} from './prootController';

export type EnvironmentVersions = {node: string[]; npm: string[]; pnpm: string[]; karin: string[]};
const jsonVersions = (value: string) => JSON.parse(value) as string[];

const PROBE_TIMEOUT_MS = 6_000;
const INSTALL_STEP_TIMEOUT_MS = 15 * 60 * 1000;
const PACKAGE_STEP_TIMEOUT_MS = 5 * 60 * 1000;

export async function inspectEnvironment() {
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


export async function fetchEnvironmentVersions(): Promise<EnvironmentVersions> {
  const [node, npm, pnpm, karin] = await Promise.all([
    executeAndCollect("printf '%s' '[\"22.11.0\",\"20.18.0\",\"18.20.4\"]'"), executeAndCollect("npm view npm versions --json"),
    executeAndCollect("npm view pnpm versions --json"), executeAndCollect("npm view node-karin versions --json"),
  ]);
  return {node: jsonVersions(node).filter(value => Number(value.split('.')[0]) >= 18).reverse(), npm: jsonVersions(npm).reverse(), pnpm: jsonVersions(pnpm).reverse(), karin: jsonVersions(karin).reverse()};
}

export type EnvironmentInstallHandlers = {
  onPhase: (phase: string) => void;
  onLog: (line: string) => void;
};

const clipLogLine = (line: string) => (line.length > 180 ? `${line.slice(0, 180)}…` : line);

async function runStreaming(command: string, onLog: (line: string) => void, timeoutMs: number) {
  onLog(`$ ${command}`);
  await executeStreaming(command, line => {
    const clipped = clipLogLine(line);
    if (clipped.trim()) onLog(clipped);
  }, timeoutMs);
}

export async function installEnvironment({onPhase, onLog}: EnvironmentInstallHandlers) {
  onPhase('正在检查 Node.js');
  let current = await inspectEnvironment();

  if (current.node && Number(current.node.split('.')[0]) >= 24) {
    onLog(`node --version -> v${current.node}`);
  } else {
    onPhase('正在安装 Node.js (v24.0.0)');
    await runStreaming('apt-get update && apt-get install -y curl xz-utils && curl -fsSL https://nodejs.org/dist/v24.0.0/node-v24.0.0-linux-arm64.tar.xz -o /tmp/node.tar.xz && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm -f /tmp/node.tar.xz', onLog, INSTALL_STEP_TIMEOUT_MS);
    onPhase('Node.js 安装完成');
    current = await inspectEnvironment();
  }

  if (current.npm) {
    onLog(`npm --version -> ${current.npm}`);
  } else {
    onPhase('正在安装 npm');
    await runStreaming('npm install -g npm@latest', onLog, PACKAGE_STEP_TIMEOUT_MS);
    onPhase('npm 安装完成');
    current = await inspectEnvironment();
  }

  if (current.pnpm && current.pnpm.startsWith('9.')) {
    onLog(`pnpm --version -> ${current.pnpm}`);
  } else {
    onPhase('正在安装 pnpm');
    await runStreaming('npm install -g pnpm@9', onLog, PACKAGE_STEP_TIMEOUT_MS);
    onPhase('pnpm 安装完成');
  }

  onPhase('正在准备 Karin');
  await runStreaming('mkdir -p /root/karin && test -f /root/karin/node_modules/node-karin/package.json || (cd /root/karin && pnpm i node-karin@latest && pnpm exec karin init)', onLog, PACKAGE_STEP_TIMEOUT_MS);
  onPhase('运行环境准备完成');
  const final = await inspectEnvironment();
  onLog(`Node.js ${final.node || '-'} / npm ${final.npm || '-'} / pnpm ${final.pnpm || '-'} / node-karin ${final.karin || '-'}`);
}
