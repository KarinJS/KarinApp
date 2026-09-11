import {EventSubscription} from 'react-native';
import {executeAndCollect, prootController} from './prootController';

type KarinProbeResult = {running: boolean; memoryBytes: number};

/** karin 长驻进程在 prootController 中的固定 commandId，kill/日志订阅都以此为准。 */
export const KARIN_COMMAND_ID = 'karin-service';
const START_COMMAND = 'cd /root/karin && node index.mjs';
const PROBE_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 8_000;

/**
 * 单行探针脚本，经 sh -c 执行：扫描 /proc 下 cmdline 含 index.mjs 的进程，
 * 汇总其 VmRSS 后输出 JSON。脚本必须排除自身（process.pid）与父进程 sh（process.ppid），
 * 否则探针命令行里同样带有 index.mjs 字样，会被误判为 karin。
 * 匹配词只用 index.mjs：环境探测等兄弟进程的 cmdline 含有 node-karin 路径字样，
 * 若用 node-karin 做匹配词会把它们误判为 karin 进程。
 * 注意脚本内不能出现单引号，整条命令用单引号包裹传给 sh -c。
 */
const PROBE_COMMAND = `node -e '${[
  'const fs=require("fs");',
  'const skip=new Set([process.pid,process.ppid]);',
  'let found=0,mem=0;',
  'for(const e of fs.readdirSync("/proc")){',
  'if(!/^\\d+$/.test(e))continue;',
  'if(skip.has(Number(e)))continue;',
  'let cmd="";',
  'try{cmd=fs.readFileSync("/proc/"+e+"/cmdline","utf8")}catch{}',
  'if(cmd.indexOf("index.mjs")<0)continue;',
  'found++;',
  'try{',
  'const st=fs.readFileSync("/proc/"+e+"/status","utf8");',
  'const m=st.match(/VmRSS:\\s*(\\d+)\\s*kB/);',
  'if(m)mem+=Number(m[1]);',
  '}catch{}',
  '}',
  'console.log(JSON.stringify({running:found>0,memoryBytes:mem*1024}));',
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
    };
  } catch {
    // 容器未运行、命令超时等情况一律视为未运行
    return {running: false, memoryBytes: 0};
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

function stop(): Promise<void> {
  return new Promise(resolve => {
    const state = {
      settled: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      subscription: undefined as EventSubscription | undefined,
    };
    const finish = () => {
      if (state.settled) return;
      state.settled = true;
      if (state.timer) clearTimeout(state.timer);
      state.subscription?.remove();
      startedAt = null;
      resolve();
    };
    state.subscription = prootController.subscribe(event => {
      if (event.commandId === KARIN_COMMAND_ID && event.stream === 'exit') finish();
    });
    // 兜底：exit 事件丢失时不至于一直挂起
    state.timer = setTimeout(finish, STOP_TIMEOUT_MS);
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
