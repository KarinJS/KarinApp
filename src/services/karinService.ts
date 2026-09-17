import {EventSubscription} from 'react-native';
import {executeAndCollect, prootController} from './prootController';

type KarinProbeResult = {running: boolean; memoryBytes: number; ok: boolean};

/** karin 长驻进程在 prootController 中的固定 commandId，kill/日志订阅都以此为准。 */
export const KARIN_COMMAND_ID = 'karin-service';
const START_COMMAND = 'cd /root/karin && sh -c "echo \\$\\$ > /tmp/karin.pid; exec node index.mjs"';
const PROBE_TIMEOUT_MS = 10_000;
/** 守护进程发给 node-karin 的 SIGTERM 宽限期，与 karin-ipc 的 GRACEFUL_EXIT_MS 保持一致。 */
const STOP_GRACE_MS = 10_000;
/** 宽限期之外再等退出事件的时间；只用于事件丢失时兜底，正常走不到。 */
const STOP_FORCE_MS = 3_000;

/**
 * 单行探针脚本，经 sh -c 执行：扫描 /proc，找到真正以 index.mjs 为参数的 Karin 主进程，
 * 再按 Karin 命令的进程组汇总整个进程组的 VmRSS。只匹配独立参数，避免探针自身的
 * `node -e` 脚本文本里出现 index.mjs 时被误判为 Karin；进程组也能覆盖脱离父进程的 worker。
 * 注意脚本内不能出现单引号，整条命令用单引号包裹传给 sh -c。
 */
const PROBE_COMMAND = `node -e '${[
  'const fs=require("fs");',
  'const skip=new Set([process.pid,process.ppid]);',
  'let rootPid=0;',
  'try{rootPid=Number(fs.readFileSync("/tmp/karin.pid","utf8").trim())}catch{}',
  'const procs=new Map();',
  'for(const e of fs.readdirSync("/proc")){',
  'if(!/^\\d+$/.test(e))continue;',
  'const pid=Number(e);',
  'if(skip.has(pid))continue;',
  'try{',
  'const stat=fs.readFileSync("/proc/"+e+"/stat","utf8");',
  'const close=stat.lastIndexOf(")");',
  'const fields=stat.slice(close+2).trim().split(/\\s+/);',
  'const pgrp=Number(fields[2]);',
  'procs.set(pid,{pgrp});',
  '}catch{}',
  '}',
  'const isKarinCmd=cmd=>cmd.split("\\0").some(arg=>arg==="index.mjs"||/(^|\\/)index\\.mjs$/.test(arg));',
  'const roots=[];',
  'if(rootPid&&procs.has(rootPid)){try{if(isKarinCmd(fs.readFileSync("/proc/"+rootPid+"/cmdline","utf8")))roots.push(rootPid)}catch{}}',
  'if(!roots.length)for(const [pid] of procs){try{if(isKarinCmd(fs.readFileSync("/proc/"+pid+"/cmdline","utf8")))roots.push(pid)}catch{}}',
  'const groups=new Set(roots.map(pid=>procs.get(pid)?.pgrp).filter(Boolean));',
  'let mem=0;',
  'let found=false;',
  'for(const [pid,p] of procs){',
  'if(!groups.has(p.pgrp))continue;',
  'found=true;',
  'if(procs.has(pid)){',
  'try{',
  'const status=fs.readFileSync("/proc/"+pid+"/status","utf8");',
  'const match=status.match(/VmRSS:\\s*(\\d+)\\s*kB/);',
  'if(match)mem+=Number(match[1]);',
  '}catch{}',
  '}',
  '}',
  'console.log(JSON.stringify({running:found,memoryBytes:mem*1024}));',
].join('')}'`;

/** 本地记录的启动时间戳；进程异常退出（subscribeExit）或 stop 时清除。 */
let startedAt: number | null = null;

async function probe(): Promise<KarinProbeResult> {
  try {
    const output = await executeAndCollect(PROBE_COMMAND, PROBE_TIMEOUT_MS);
    // executeAndCollect 会合并 stderr，取最后一行解析，避免 node 警告污染 JSON
    const lines = output.trim().split('\n');
    const parsed: unknown = JSON.parse(lines[lines.length - 1]);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('探针输出格式错误');
    const result = parsed as Partial<KarinProbeResult>;
    return {
      running: result.running === true,
      memoryBytes: typeof result.memoryBytes === 'number' ? result.memoryBytes : 0,
      ok: true,
    };
  } catch {
    // 容器未运行、命令超时等情况标记为不可用；界面保留上一次有效统计，避免瞬时闪为 0
    return {running: false, memoryBytes: 0, ok: false};
  }
}

async function start(): Promise<void> {
  if ((await probe()).running) return;
  /** interactive：守护进程保留 stdin 管道，控制台输入才能送进 node-karin。 */
  await prootController.execute(START_COMMAND, KARIN_COMMAND_ID, true);
  startedAt = Date.now();
}

/** 向 Karin 控制台发送一行输入；node-karin 通过 process.stdin 的 data 事件接收。 */
function sendInput(text: string): Promise<string> {
  return prootController.write(KARIN_COMMAND_ID, text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * 优雅停止：发 KILL 帧后由容器内守护进程先给 node-karin 发 SIGTERM，让它自己走退出清理
 * （未落盘的内容不丢），10 秒内还没退出才 SIGKILL。这里只等 exit 事件。
 * 进程本来就不在时先 probe() 直接返回，不空等宽限期。
 */
async function stop(): Promise<void> {
  if (!(await probe()).running) {
    startedAt = null;
    return;
  }
  await new Promise<void>(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscription: EventSubscription | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      subscription?.remove();
      startedAt = null;
      resolve();
    };
    subscription = prootController.subscribe(event => {
      if (event.commandId === KARIN_COMMAND_ID && event.stream === 'exit') finish();
    });
    timer = setTimeout(finish, STOP_GRACE_MS + STOP_FORCE_MS);
    // 容器没起来时 kill 会 reject：没有可停的进程，直接结束。
    prootController.kill(KARIN_COMMAND_ID).catch(() => finish());
  });
}

function getStartedAt(): number | null {
  return startedAt;
}

/** 订阅 karin 进程退出事件；触发时清除 startedAt，返回取消订阅函数。 */
function subscribeExit(callback: () => void): () => void {
  const subscription = prootController.subscribe(event => {
    if (event.commandId !== KARIN_COMMAND_ID || event.stream !== 'exit') return;
    startedAt = null;
    callback();
  });
  return () => subscription.remove();
}

export const karinService = {start, stop, probe, getStartedAt, subscribeExit, sendInput};
