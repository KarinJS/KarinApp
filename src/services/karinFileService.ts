import {executeAndCollect} from './prootController';

// Hermes 运行时提供 atob/btoa，但 RN 的 TS 类型未声明
declare const atob: (data: string) => string;
declare const btoa: (data: string) => string;

export type FileEntry = {name: string; isDir: boolean; size: number};

const ROOT = '/root/karin';
const MAX_FILE_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

/** 把相对 /root/karin 的路径规范化为容器内绝对路径；拒绝绝对路径和 .. 逃逸。 */
function resolvePath(relPath: string): string {
  const parts: string[] = [];
  for (const segment of relPath.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) throw new Error('路径越界：只能访问 Karin 项目目录内的文件');
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length ? `${ROOT}/${parts.join('/')}` : ROOT;
}

/** UTF-8 安全的 base64 编解码（Hermes 的 atob/btoa 只接受 Latin-1）。 */
const toBase64 = (text: string) => btoa(unescape(encodeURIComponent(text)));
const fromBase64 = (base64: string) => decodeURIComponent(escape(atob(base64)));

/**
 * 拼一条 node 单行脚本经 sh -c 执行：路径与内容一律以 base64 传入，
 * 脚本体内只允许出现双引号，彻底避开 shell 引号转义问题。
 */
function nodeExec(body: string): string {
  if (body.includes("'")) throw new Error('脚本体不能包含单引号');
  return `node -e '${body}'`;
}

/** 列出目录内容（跳过 node_modules），目录在前、按名称排序。 */
export async function list(relDir: string): Promise<FileEntry[]> {
  const dir = toBase64(resolvePath(relDir));
  const body =
    'const fs=require("fs");' +
    `const p=Buffer.from("${dir}","base64").toString();` +
    'const out=[];' +
    'for(const e of fs.readdirSync(p,{withFileTypes:true})){' +
    'if(e.name==="node_modules")continue;' +
    'let size=0;' +
    'try{if(!e.isDirectory())size=fs.statSync(p+"/"+e.name).size}catch{}' +
    'out.push({name:e.name,isDir:e.isDirectory(),size});' +
    '}' +
    'console.log(JSON.stringify(out))';
  const output = await executeAndCollect(nodeExec(body), COMMAND_TIMEOUT_MS);
  const lines = output.trim().split('\n');
  const parsed: unknown = JSON.parse(lines[lines.length - 1]);
  if (!Array.isArray(parsed)) throw new Error('目录列表格式错误');
  const entries = parsed as FileEntry[];
  return entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

/** 读取文本文件内容；非普通文件或超过 512KB 拒绝。 */
export async function readFile(relPath: string): Promise<string> {
  const file = toBase64(resolvePath(relPath));
  const body =
    'const fs=require("fs");' +
    `const p=Buffer.from("${file}","base64").toString();` +
    'const st=fs.statSync(p);' +
    'if(!st.isFile()){console.error("不是普通文件");process.exit(2)}' +
    `if(st.size>${MAX_FILE_BYTES}){console.error("文件超过 512KB，暂不支持编辑");process.exit(2)}` +
    'process.stdout.write(fs.readFileSync(p).toString("base64"))';
  const output = await executeAndCollect(nodeExec(body), COMMAND_TIMEOUT_MS);
  // executeAndCollect 会合并 stderr，base64 负载是输出中最后一段纯 base64 字符行
  const payload = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[A-Za-z0-9+/]+=*$/.test(line))
    .pop();
  if (payload === undefined) {
    if (!output.trim()) return ''; // 空文件
    throw new Error('文件内容读取失败');
  }
  return fromBase64(payload);
}

/** 覆盖写入文本文件；内容超过 512KB 拒绝。 */
export async function writeFile(relPath: string, content: string): Promise<void> {
  const file = toBase64(resolvePath(relPath));
  const data = toBase64(content);
  if (data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new Error('内容超过 512KB，暂不支持保存');
  const body =
    'const fs=require("fs");' +
    `fs.writeFileSync(Buffer.from("${file}","base64").toString(),Buffer.from("${data}","base64"))`;
  await executeAndCollect(nodeExec(body), COMMAND_TIMEOUT_MS);
}

/** 移动/重命名文件或目录。 */
export async function move(srcRel: string, dstRel: string): Promise<void> {
  const src = toBase64(resolvePath(srcRel));
  const dst = toBase64(resolvePath(dstRel));
  const body =
    'const fs=require("fs");' +
    `fs.renameSync(Buffer.from("${src}","base64").toString(),Buffer.from("${dst}","base64").toString())`;
  await executeAndCollect(nodeExec(body), COMMAND_TIMEOUT_MS);
}

/** 递归复制文件或目录。 */
export async function copy(srcRel: string, dstRel: string): Promise<void> {
  const src = toBase64(resolvePath(srcRel));
  const dst = toBase64(resolvePath(dstRel));
  const body =
    'const fs=require("fs");' +
    `fs.cpSync(Buffer.from("${src}","base64").toString(),Buffer.from("${dst}","base64").toString(),{recursive:true})`;
  await executeAndCollect(nodeExec(body), COMMAND_TIMEOUT_MS);
}

/** 递归删除文件或目录；拒绝删除根目录本身。 */
export async function remove(relPath: string): Promise<void> {
  const resolved = resolvePath(relPath);
  if (resolved === ROOT) throw new Error('不能删除根目录本身');
  const file = toBase64(resolved);
  const body =
    'const fs=require("fs");' +
    `fs.rmSync(Buffer.from("${file}","base64").toString(),{recursive:true,force:true})`;
  await executeAndCollect(nodeExec(body), COMMAND_TIMEOUT_MS);
}

/** 新建空文件；已存在则报错。 */
export async function createFile(relPath: string): Promise<void> {
  const file = toBase64(resolvePath(relPath));
  const body =
    'const fs=require("fs");' +
    `const p=Buffer.from("${file}","base64").toString();` +
    'try{fs.writeFileSync(p,"",{flag:"wx"})}catch(e){if(e&&e.code==="EEXIST"){console.error("已存在同名文件或目录");process.exit(2)}throw e}';
  await executeAndCollect(nodeExec(body), COMMAND_TIMEOUT_MS);
}

/** 新建目录；已存在则报错。 */
export async function createDirectory(relPath: string): Promise<void> {
  const dir = toBase64(resolvePath(relPath));
  const body =
    'const fs=require("fs");' +
    `const p=Buffer.from("${dir}","base64").toString();` +
    'try{fs.mkdirSync(p)}catch(e){if(e&&e.code==="EEXIST"){console.error("已存在同名文件或目录");process.exit(2)}throw e}';
  await executeAndCollect(nodeExec(body), COMMAND_TIMEOUT_MS);
}

export const karinFileService = {list, readFile, writeFile, move, copy, remove, createFile, createDirectory};
