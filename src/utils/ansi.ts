/* eslint-disable no-control-regex -- 这个模块的职责就是解析 ANSI 控制序列，正则里必须出现 ESC 等控制字符。 */
import type {TextStyle} from 'react-native';

/** 一行日志里的一段文本：同一段共享一份 ANSI 样式。 */
export type AnsiStyle = {
  /** 终端调色板索引 0-15；未指定时继承所在日志流的默认颜色。 */
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
};

export type AnsiSegment = AnsiStyle & {text: string};

const ESC = '\u001B';
/** CSI 序列：ESC [ 参数 终止字母。 */
const CSI_PATTERN = /^\u001B\[([0-9;?]*)([A-Za-z])/;
/** OSC 序列：ESC ] ... BEL 或 ESC \。 */
const OSC_PATTERN = /^\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/;
/** 行尾被截断的 CSI（超过守护进程 MAX_LINE 的行会不带换行 flush）。 */
const PARTIAL_CSI_PATTERN = /^\u001B\[[0-9;?]*$/;

/**
 * 终端 16 色调色板。ANSI 颜色是调色板语义而非固定 RGB，浅色背景上需要压暗，
 * 暗色背景上需要提亮，否则 30 号黑字在深色界面上会直接看不见。
 */
const PALETTE_LIGHT = [
  '#2B1F24', // 30 黑
  '#B91C1C', // 31 红
  '#15803D', // 32 绿
  '#9A6B00', // 33 黄
  '#1D4ED8', // 34 蓝
  '#A21CAF', // 35 品红
  '#0E7490', // 36 青
  '#6B7280', // 37 白（浅底上用中性灰）
  '#9CA3AF', // 90 亮黑
  '#DC2626', // 91 亮红
  '#16A34A', // 92 亮绿
  '#CA8A04', // 93 亮黄
  '#2563EB', // 94 亮蓝
  '#C026D3', // 95 亮品红
  '#0891B2', // 96 亮青
  '#111827', // 97 亮白
];

const PALETTE_DARK = [
  '#9C9199', // 30 黑
  '#FB7185', // 31 红
  '#4ADE80', // 32 绿
  '#FBBF74', // 33 黄
  '#7CA9FF', // 34 蓝
  '#E879F9', // 35 品红
  '#5EEAD4', // 36 青
  '#E8E2E4', // 37 白
  '#8B7F85', // 90 亮黑
  '#FDA4AF', // 91 亮红
  '#86EFAC', // 92 亮绿
  '#FDE68A', // 93 亮黄
  '#A5C8FF', // 94 亮蓝
  '#F0ABFC', // 95 亮品红
  '#A7F3D0', // 96 亮青
  '#FFFFFF', // 97 亮白
];

export function ansiColor(index: number, dark: boolean): string {
  const palette = dark ? PALETTE_DARK : PALETTE_LIGHT;
  return palette[index] ?? (dark ? '#E8E2E4' : '#2B1F24');
}

/** 把一段 SGR 参数串叠加到当前样式上，返回新样式（不改原对象）。 */
function applySgr(current: AnsiStyle, params: string): AnsiStyle {
  let next: AnsiStyle = {...current};
  const codes = params.length === 0 ? [0] : params.split(';').map(part => (part === '' ? 0 : Number(part)));
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (!Number.isFinite(code)) continue;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 24) delete next.underline;
    else if (code === 39) delete next.fg;
    else if (code === 49) delete next.bg;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code >= 90 && code <= 97) next.fg = code - 82;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code >= 100 && code <= 107) next.bg = code - 92;
    else if (code === 38 || code === 48) {
      // 38;5;n / 48;5;n：只有前 16 个能落到调色板；真彩色与其余 256 色忽略，
      // 但要按参数个数跳过，否则参数会漏成正文。
      const mode = codes[index + 1];
      const palette = codes[index + 2];
      if (mode === 5) {
        if (palette >= 0 && palette < 16) {
          if (code === 38) next.fg = palette;
          else next.bg = palette;
        }
        index += 2;
      } else if (mode === 2) index += 4;
    }
  }
  return next;
}

/**
 * 按 ANSI 控制码把一行日志切成若干样式段。颜色/加粗保留成结构化样式，
 * 光标、清屏、OSC 之类的序列直接丢弃；所以段里的 text 是纯可见文本，复制出来不带转义序列。
 * 调色板取色留到渲染时做，主题切换不需要重新解析。
 */
export function parseAnsiLine(raw: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let buffer = '';
  let index = 0;

  const flush = () => {
    if (!buffer) return;
    segments.push({text: buffer, ...style});
    buffer = '';
  };

  while (index < raw.length) {
    const char = raw[index];
    if (char !== ESC) {
      buffer += char;
      index += 1;
      continue;
    }

    const csi = CSI_PATTERN.exec(raw.slice(index, index + 32));
    if (csi) {
      if (csi[2] === 'm') {
        flush();
        style = applySgr(style, csi[1]);
      }
      index += csi[0].length;
      continue;
    }
    const osc = OSC_PATTERN.exec(raw.slice(index, index + 128));
    if (osc) {
      index += osc[0].length;
      continue;
    }
    // 行尾被截断的转义序列整段丢弃，避免 `[3` 之类的残渣漏进正文。
    if (PARTIAL_CSI_PATTERN.test(raw.slice(index))) break;
    index += 1;
  }
  flush();
  return segments;
}

/** 把结构化样式翻译成 RN 文本样式；没有任何样式时返回 undefined，交给父节点继承。 */
export function ansiSegmentStyle(style: AnsiStyle, dark: boolean): TextStyle | undefined {
  if (style.fg === undefined && style.bg === undefined && !style.bold && !style.dim && !style.underline) {
    return undefined;
  }
  return {
    ...(style.fg !== undefined ? {color: ansiColor(style.fg, dark)} : null),
    ...(style.bg !== undefined ? {backgroundColor: ansiColor(style.bg, dark)} : null),
    ...(style.bold ? {fontWeight: '700' as const} : null),
    ...(style.dim ? {opacity: 0.5} : null),
    ...(style.underline ? {textDecorationLine: 'underline' as const} : null),
  };
}
