import React, {useMemo} from 'react';
import {ScrollView, StyleSheet, Text} from 'react-native';
import {highlight, registerLanguage, HastNode} from 'lowlight/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import bash from 'highlight.js/lib/languages/bash';
import ini from 'highlight.js/lib/languages/ini';
import {Colors} from '../theme/colors';

type Props = {
  colors: Colors;
  code: string;
  fileName: string;
};

// 只注册查看器实际用到的语言，避免全量 highlight.js 拖慢启动
registerLanguage('javascript', javascript);
registerLanguage('typescript', typescript);
registerLanguage('json', json);
registerLanguage('yaml', yaml);
registerLanguage('bash', bash);
registerLanguage('ini', ini);

/** 高亮片段颜色取自主题，保证深浅色下都可读。 */
type ColorKey = 'text' | 'accent' | 'success' | 'muted' | 'purple' | 'orange';

type Token = {text: string; color: ColorKey};

type Lang = 'javascript' | 'typescript' | 'json' | 'yaml' | 'bash' | 'ini' | 'plain';

/** hljs 类名（去掉 hljs- 前缀后）到主题色的映射。 */
const CLASS_COLORS: Record<string, ColorKey> = {
  keyword: 'accent',
  'selector-tag': 'accent',
  built_in: 'accent',
  name: 'accent',
  literal: 'accent',
  string: 'success',
  regexp: 'success',
  comment: 'muted',
  quote: 'muted',
  number: 'purple',
  symbol: 'purple',
  attr: 'orange',
  attribute: 'orange',
  title: 'orange',
  section: 'orange',
  variable: 'orange',
  'template-variable': 'orange',
};

/** 按扩展名选择 highlight.js 语言；无匹配则不高亮。 */
function detectLang(fileName: string): Lang {
  const base = (fileName.split('/').pop() ?? fileName).toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return 'ini';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
  switch (ext) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.json':
      return 'json';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.sh':
      return 'bash';
    case '.ini':
    case '.conf':
      return 'ini';
    default:
      return 'plain';
  }
}

/** 用 lowlight（highlight.js）把整段代码解析成带配色的片段数组，换行原样保留在文本里。 */
function tokenize(code: string, lang: Lang): Token[] {
  if (lang === 'plain') return [{text: code, color: 'text'}];
  try {
    const root = highlight(lang, code, {prefix: 'hljs-'});
    const tokens: Token[] = [];
    const walk = (nodes: HastNode[], color: ColorKey) => {
      for (const node of nodes) {
        if (node.type === 'text') {
          // 相邻同色片段合并，减少 Text 节点数量
          const lastToken = tokens[tokens.length - 1];
          if (lastToken && lastToken.color === color) lastToken.text += node.value;
          else tokens.push({text: node.value, color});
        } else if (node.type === 'element') {
          const cls = (node.properties?.className ?? []).find(name => name.startsWith('hljs-'));
          walk(node.children ?? [], (cls && CLASS_COLORS[cls.slice(5)]) || color);
        }
      }
    };
    walk(root.value, 'text');
    return tokens;
  } catch {
    return [{text: code, color: 'text'}];
  }
}

/** 只读代码查看器：lowlight 高亮渲染，无输入叠加层，滚动不会重影。 */
export default function CodeViewer({colors, code, fileName}: Props) {
  const tokens = useMemo(() => tokenize(code, detectLang(fileName)), [code, fileName]);
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.code} selectable>
        {tokens.map((token, index) => (
          <Text key={index} style={{color: colors[token.color]}}>
            {token.text}
          </Text>
        ))}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  content: {padding: 10},
  code: {fontFamily: 'monospace', fontSize: 12, lineHeight: 18},
});
