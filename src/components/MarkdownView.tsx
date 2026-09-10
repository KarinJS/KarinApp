import React, {useEffect, useMemo, useState} from 'react';
import {Image, Pressable, ScrollView, StyleProp, StyleSheet, Text, TextStyle, useWindowDimensions, View} from 'react-native';
import {SvgXml} from 'react-native-svg';
import {CheckCircle2, ChevronDown, ChevronRight, Circle} from 'lucide-react-native';
import {Lexer, Token, Tokens} from 'marked';
import {HastNode, highlight, registerLanguage} from 'lowlight/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdownLanguage from 'highlight.js/lib/languages/markdown';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import {Colors} from '../theme/colors';
import {proxiedUrl} from '../services/appSettings';
import {HtmlElementNode, HtmlNode, htmlTextContent, parseHtmlFragment} from '../utils/html';

type Props = {
  colors: Colors;
  markdown: string;
  onLinkPress: (url: string) => void;
  baseUrl?: string;
};

type ColorKey = 'text' | 'accent' | 'success' | 'muted' | 'purple' | 'orange';
type CodeToken = {text: string; color: ColorKey};
type ImageSize = {width: number; height: number};
type SvgSize = {width?: number; height?: number};

const inlineStyle = (colors: Colors) => ({
  paragraph: {color: colors.text, fontSize: 13, lineHeight: 21},
  strong: {fontWeight: '800' as const},
  emphasis: {fontStyle: 'italic' as const},
  deleted: {textDecorationLine: 'line-through' as const},
  code: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
    color: colors.purple,
    backgroundColor: colors.neutralSoft,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  link: {color: colors.accent, fontWeight: '700' as const},
});

const headingDepth = (tag: string) => Number(tag.replace('h', '')) || 3;

const htmlAlign = (value?: string) => {
  if (value === 'center') return 'center' as const;
  if (value === 'right') return 'right' as const;
  return 'left' as const;
};

const htmlStyleAlign = (value?: string) => {
  const match = value?.match(/(?:^|;)\s*text-align\s*:\s*(center|right)\s*(?:;|$)/i);
  return htmlAlign(match?.[1]);
};

const htmlNodeAlign = (node: HtmlElementNode) => htmlAlign(node.attributes.align ?? htmlStyleAlign(node.attributes.style));

const blockContainerTags = new Set(['div', 'center', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'figure']);
const blockHtmlTagPattern = /^\s*<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>\s*$/;

const openingBlockContainer = (value: string) => {
  const match = value.match(blockHtmlTagPattern);
  if (!match || match[0].startsWith('</')) return null;
  const tag = match[1].toLowerCase();
  if (!blockContainerTags.has(tag)) return null;
  const nodes = parseHtmlFragment(value);
  const node = nodes.length === 1 && nodes[0].type === 'element' && nodes[0].tag === tag ? nodes[0] : null;
  return node?.children.length === 0 ? node : null;
};

const closingBlockTag = (value: string) => {
  const match = value.match(blockHtmlTagPattern);
  return match?.[0].startsWith('</') ? match[1].toLowerCase() : null;
};

const findMatchingBlockClose = (items: Token[], startIndex: number, tag: string) => {
  let depth = 1;
  for (let index = startIndex + 1; index < items.length; index += 1) {
    const item = items[index];
    if (item.type !== 'html') continue;
    const closingTag = closingBlockTag(item.raw);
    if (closingTag === tag) {
      depth -= 1;
      if (depth === 0) return index;
    } else if (openingBlockContainer(item.raw)?.tag === tag) {
      depth += 1;
    }
  }
  return -1;
};

const languageAliases: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  bash: 'bash',
  shell: 'bash',
  sh: 'bash',
  zsh: 'bash',
  ini: 'ini',
  env: 'ini',
  css: 'css',
  html: 'xml',
  xml: 'xml',
  md: 'markdown',
  markdown: 'markdown',
};

registerLanguage('javascript', javascript);
registerLanguage('typescript', typescript);
registerLanguage('json', json);
registerLanguage('yaml', yaml);
registerLanguage('bash', bash);
registerLanguage('ini', ini);
registerLanguage('css', css);
registerLanguage('xml', xml);
registerLanguage('markdown', markdownLanguage);

const classColors: Record<string, ColorKey> = {
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

function highlightCode(code: string, language?: string): CodeToken[] {
  const registeredLanguage = languageAliases[language?.toLowerCase() ?? ''];
  if (!registeredLanguage) return [{text: code, color: 'text'}];

  try {
    const root = highlight(registeredLanguage, code, {prefix: 'hljs-'});
    const tokens: CodeToken[] = [];
    const walk = (nodes: HastNode[], color: ColorKey) => {
      for (const node of nodes) {
        if (node.type === 'text') {
          const lastToken = tokens[tokens.length - 1];
          if (lastToken && lastToken.color === color) lastToken.text += node.value;
          else tokens.push({text: node.value, color});
        } else if (node.type === 'element') {
          const className = (node.properties?.className ?? []).find(name => name.startsWith('hljs-'));
          walk(node.children ?? [], (className && classColors[className.slice(5)]) || color);
        }
      }
    };
    walk(root.value, 'text');
    return tokens;
  } catch {
    return [{text: code, color: 'text'}];
  }
}

function MarkdownCodeBlock({colors, code, language}: {colors: Colors; code: string; language?: string}) {
  const tokens = useMemo(() => highlightCode(code, language), [code, language]);

  return (
    <View style={[markdownStyles.codeBlock, {backgroundColor: colors.neutralSoft, borderColor: colors.border}]}>
      {language ? <Text style={[markdownStyles.codeLanguage, {color: colors.muted}]}>{language}</Text> : null}
      <ScrollView contentContainerStyle={markdownStyles.codeScrollContent} horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={[markdownStyles.codeText, {color: colors.text}]}>
          {tokens.map((token, index) => (
            <Text key={index} style={{color: colors[token.color]}}>
              {token.text}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </View>
  );
}

const svgUriHosts = new Set(['socialify.git.ci', 'count.kjchmc.cn']);

const isSvgUri = (uri: string) => {
  try {
    const url = new URL(uri);
    return url.pathname.toLowerCase().endsWith('.svg') || svgUriHosts.has(url.hostname.toLowerCase());
  } catch {
    return /\.svg(?:[?#]|$)/i.test(uri);
  }
};

const svgAttribute = (tag: string, name: string) => {
  const match = tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

const svgDimension = (value?: string) => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const svgSize = (source: string): SvgSize => {
  const tag = source.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) return {};
  const width = svgDimension(svgAttribute(tag, 'width'));
  const height = svgDimension(svgAttribute(tag, 'height'));
  const viewBox = svgAttribute(tag, 'viewBox')?.trim().split(/[\s,]+/).map(Number);
  const viewBoxWidth = viewBox?.length === 4 && viewBox.every(Number.isFinite) ? viewBox[2] : undefined;
  const viewBoxHeight = viewBox?.length === 4 && viewBox.every(Number.isFinite) ? viewBox[3] : undefined;
  return {width: width ?? viewBoxWidth, height: height ?? viewBoxHeight};
};

const isSvgDocument = (source: string) => /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(source);

function MarkdownImage({uri, alt, width, height}: {uri: string; alt?: string; width?: number; height?: number}) {
  const {width: screenWidth} = useWindowDimensions();
  const [naturalSize, setNaturalSize] = useState<ImageSize | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [useRasterImage, setUseRasterImage] = useState(!isSvgUri(uri));
  const maxWidth = Math.max(120, Math.min(screenWidth - 48, 760));

  useEffect(() => {
    if (!isSvgUri(uri)) {
      setSvg(null);
      setUseRasterImage(true);
      return undefined;
    }

    let active = true;
    setSvg(null);
    setUseRasterImage(false);
    fetch(uri)
      .then(async response => {
        if (!response.ok) throw new Error(`SVG image request failed (${response.status})`);
        const source = await response.text();
        if (!active) return;
        if (isSvgDocument(source)) setSvg(source);
        else setUseRasterImage(true);
      })
      .catch(() => {
        if (active) setUseRasterImage(true);
      });

    return () => {
      active = false;
    };
  }, [uri]);

  const intrinsicSize = useMemo(() => (svg ? svgSize(svg) : null), [svg]);
  const measuredWidth = intrinsicSize?.width ?? naturalSize?.width;
  const measuredHeight = intrinsicSize?.height ?? naturalSize?.height;
  const aspectRatio = measuredWidth && measuredHeight ? measuredWidth / measuredHeight : 16 / 9;
  const resolvedWidth = width ?? Math.min(measuredWidth ?? maxWidth, maxWidth);
  const resolvedHeight = height ?? Math.max(1, resolvedWidth / aspectRatio);

  if (!useRasterImage) {
    if (!svg) return <View style={[markdownStyles.image, {width: resolvedWidth, height: resolvedHeight}]} />;
    return (
      <SvgXml
        accessibilityLabel={alt}
        height={resolvedHeight}
        onError={() => setUseRasterImage(true)}
        style={markdownStyles.image}
        width={resolvedWidth}
        xml={svg}
      />
    );
  }

  return (
    <Image
      accessibilityLabel={alt}
      resizeMode='contain'
      source={{uri}}
      style={[markdownStyles.image, {width: resolvedWidth, height: resolvedHeight}]}
      onLoad={event => {
        const source = event.nativeEvent.source;
        if (source.width > 0 && source.height > 0) setNaturalSize({width: source.width, height: source.height});
      }}
    />
  );
}

function HtmlDetails({
  colors,
  defaultOpen,
  summary,
  children,
}: {
  colors: Colors;
  defaultOpen: boolean;
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <View style={[markdownStyles.details, {borderColor: colors.border}]}>
      <Pressable
        accessibilityRole='button'
        accessibilityState={{expanded: open}}
        onPress={() => setOpen(value => !value)}
        style={markdownStyles.detailsHeader}>
        <View style={markdownStyles.detailsSummary}>{summary}</View>
        <ChevronDown
          color={colors.muted}
          size={14}
          style={open ? markdownStyles.detailsChevronExpanded : markdownStyles.detailsChevron}
        />
      </Pressable>
      {open ? <View style={markdownStyles.detailsContent}>{children}</View> : null}
    </View>
  );
}

function resolveUrl(value: string | undefined, kind: 'image' | 'link', baseUrl?: string): string | undefined {
  const resolved = resolveDirectUrl(value, kind, baseUrl);
  /** 图片走用户配置的 GitHub 加速前缀，国内也能加载 raw 图 */
  return kind === 'image' && resolved ? proxiedUrl(resolved) : resolved;
}

function resolveDirectUrl(value: string | undefined, kind: 'image' | 'link', baseUrl?: string): string | undefined {
  if (!value || !baseUrl || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('#')) {
    return value;
  }

  try {
    const base = new URL(baseUrl);
    const [owner, repository] = base.pathname.split('/').filter(Boolean);
    if (base.hostname === 'github.com' && owner && repository) {
      if (kind === 'image') {
        const path = value.replace(/^[./]+/, '');
        return encodeURI(`https://raw.githubusercontent.com/${owner}/${repository}/HEAD/${path}`);
      }
      return new URL(value, base).toString();
    }
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

const htmlNodesContainImage = (nodes: HtmlNode[]): boolean =>
  nodes.some(
    node =>
      (node.type === 'element' && node.tag === 'img') ||
      (node.type === 'element' && htmlNodesContainImage(node.children)),
  );

const tokenContainsImage = (item: Token): boolean => {
  if (item.type === 'image') return true;
  if (item.type === 'html') return htmlNodesContainImage(parseHtmlFragment(item.raw));
  return tokenListContainsImage((item as Tokens.Generic).tokens);
};

const tokenListContainsImage = (items?: Token[]): boolean => items?.some(tokenContainsImage) ?? false;

export default function MarkdownView({colors, markdown, onLinkPress, baseUrl}: Props) {
  const tokens = useMemo(() => Lexer.lex(markdown, {gfm: true, breaks: false}), [markdown]);
  const styles = useMemo(() => inlineStyle(colors), [colors]);

  const renderInline = (items?: Token[]): React.ReactNode =>
    items?.map((item, index) => {
      switch (item.type) {
        case 'strong':
          return <Text key={index} style={styles.strong}>{renderInline(item.tokens)}</Text>;
        case 'em':
          return <Text key={index} style={styles.emphasis}>{renderInline(item.tokens)}</Text>;
        case 'del':
          return <Text key={index} style={styles.deleted}>{renderInline(item.tokens)}</Text>;
        case 'codespan':
          return <Text key={index} style={styles.code}>{item.text}</Text>;
        case 'link':
          return (
            <Text
              key={index}
              onPress={() => onLinkPress(resolveUrl(item.href, 'link', baseUrl) ?? '')}
              style={styles.link}>
              {renderInline(item.tokens)}
            </Text>
          );
        case 'image': {
          const uri = resolveUrl(item.href, 'image', baseUrl);
          if (!uri) return null;
          return <MarkdownImage key={index} alt={item.text} uri={uri} />;
        }
        case 'br':
          return <Text key={index}>{'\n'}</Text>;
        case 'escape':
          return <Text key={index}>{item.text}</Text>;
        case 'html':
          return <React.Fragment key={index}>{renderHtmlNodes(parseHtmlFragment(item.raw), true)}</React.Fragment>;
        case 'text':
          return <React.Fragment key={index}>{item.tokens ? renderInline(item.tokens) : item.text}</React.Fragment>;
        default:
          return <React.Fragment key={index}>{renderInline((item as Tokens.Generic).tokens)}</React.Fragment>;
      }
    }) ?? null;

  const renderInlineBlock = (items: Token[], textStyle: StyleProp<TextStyle>): React.ReactNode => {
    const nodes: React.ReactNode[] = [];
    let textChildren: React.ReactNode[] = [];

    const flushText = (key: React.Key) => {
      if (!textChildren.length) return;
      nodes.push(
        <Text key={key} style={textStyle}>
          {textChildren}
        </Text>,
      );
      textChildren = [];
    };

    items.forEach((item, index) => {
      if (!tokenContainsImage(item)) {
        textChildren.push(<React.Fragment key={index}>{renderInline([item])}</React.Fragment>);
        return;
      }

      flushText(`text-${index}`);
      if (item.type === 'image') {
        nodes.push(renderInline([item]));
      } else if (item.type === 'link') {
        nodes.push(
          <Pressable
            accessibilityRole='link'
            key={`image-link-${index}`}
            onPress={() => onLinkPress(resolveUrl(item.href, 'link', baseUrl) ?? '')}
            style={markdownStyles.inlineGroup}>
            {renderInlineBlock(item.tokens ?? [], [textStyle, styles.link])}
          </Pressable>,
        );
      } else if (item.type === 'html') {
        nodes.push(
          <View key={`inline-html-${index}`} style={markdownStyles.inlineGroup}>
            {renderHtmlNodes(parseHtmlFragment(item.raw))}
          </View>,
        );
      } else {
        nodes.push(
          <View key={`inline-${index}`} style={markdownStyles.inlineGroup}>
            {renderInlineBlock((item as Tokens.Generic).tokens ?? [], textStyle)}
          </View>,
        );
      }
    });

    flushText(`text-${items.length}`);
    return nodes;
  };

  const renderHeading = (item: Tokens.Heading) => {
    const headingStyle = [
      {color: colors.text},
      markdownStyles.heading,
      item.depth === 1 && markdownStyles.heading1,
      item.depth === 2 && markdownStyles.heading2,
      item.depth >= 3 && markdownStyles.heading3,
      item.depth <= 2 && {borderBottomColor: colors.border},
    ];
    return (
      <Text key={item.raw} style={headingStyle}>
        {renderInline(item.tokens)}
      </Text>
    );
  };

  const renderHtmlHeading = (node: HtmlElementNode, key: React.Key) => {
    const depth = headingDepth(node.tag);
    return (
      <Text
        key={key}
        style={[
          {color: colors.text},
          markdownStyles.heading,
          depth === 1 && markdownStyles.heading1,
          depth === 2 && markdownStyles.heading2,
          depth >= 3 && markdownStyles.heading3,
          depth <= 2 && {borderBottomColor: colors.border},
          {textAlign: htmlNodeAlign(node)},
        ]}>
        {renderHtmlNodes(node.children, true)}
      </Text>
    );
  };

  const renderHtmlListItem = (node: HtmlElementNode, index: number, ordered: boolean, start: number, key: React.Key) => (
    <View key={key} style={markdownStyles.listItem}>
      {ordered ? (
        <Text style={[markdownStyles.listMarker, {color: colors.muted}]}>{start + index}.</Text>
      ) : (
        <ChevronRight color={colors.muted} size={13} />
      )}
      <View style={markdownStyles.listContent}>{renderHtmlNodes(node.children)}</View>
    </View>
  );

  const renderHtmlTablePart = (node: HtmlElementNode, key: React.Key) => {
    switch (node.tag) {
      case 'tr':
        return <View key={key} style={markdownStyles.tableRow}>{renderHtmlNodes(node.children)}</View>;
      case 'th':
      case 'td':
        return (
          <View
            key={key}
            style={[
              markdownStyles.tableCell,
              {borderColor: colors.border},
              node.tag === 'th' && {backgroundColor: colors.neutralSoft},
            ]}>
            <Text
              style={[
                {color: colors.text, textAlign: htmlNodeAlign(node)},
                node.tag === 'th' ? markdownStyles.tableHeaderText : markdownStyles.tableCellText,
              ]}>
              {renderHtmlNodes(node.children, true)}
            </Text>
          </View>
        );
      default:
        return <React.Fragment key={key}>{renderHtmlNodes(node.children)}</React.Fragment>;
    }
  };

  const renderHtmlNode = (node: HtmlNode, index: number, inline: boolean): React.ReactNode => {
    const key = `${node.type}-${node.type === 'element' ? node.tag : ''}-${index}`;

    if (node.type === 'text') {
      if (!inline && !node.text.trim()) return null;
      return <Text key={key} style={styles.paragraph}>{node.text}</Text>;
    }

    switch (node.tag) {
      case 'script':
      case 'style':
      case 'iframe':
      case 'object':
      case 'embed':
      case 'form':
      case 'input':
      case 'button':
      case 'video':
      case 'audio':
        return null;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return renderHtmlHeading(node, key);
      case 'p':
        return (
          <View
            key={key}
            style={[
              markdownStyles.inlineContainer,
              htmlNodeAlign(node) === 'center' && markdownStyles.htmlCenter,
              htmlNodeAlign(node) === 'right' && markdownStyles.htmlRight,
            ]}>
            {renderHtmlNodes(node.children, true)}
          </View>
        );
      case 'div':
      case 'section':
      case 'article':
      case 'header':
      case 'footer':
      case 'main':
      case 'nav':
      case 'aside':
      case 'figure':
      case 'center':
        return (
          <View
            key={key}
            style={[
              markdownStyles.htmlContainer,
              (htmlNodeAlign(node) === 'center' || node.tag === 'center') && markdownStyles.htmlCenter,
              htmlNodeAlign(node) === 'right' && markdownStyles.htmlRight,
            ]}>
            {renderHtmlNodes(node.children)}
          </View>
        );
      case 'figcaption':
        return (
          <Text key={key} style={[styles.paragraph, {color: colors.muted}, markdownStyles.figcaption]}>
            {renderHtmlNodes(node.children, true)}
          </Text>
        );
      case 'details': {
        const summaryNode = node.children.find(child => child.type === 'element' && child.tag === 'summary');
        const contentNodes = node.children.filter(child => child !== summaryNode);
        return (
          <HtmlDetails
            key={key}
            colors={colors}
            defaultOpen={node.attributes.open !== undefined}
            summary={
              summaryNode ? (
                renderHtmlNode(summaryNode, 0, true)
              ) : (
                <Text style={[styles.paragraph, styles.strong]}>Details</Text>
              )
            }>
            {renderHtmlNodes(contentNodes)}
          </HtmlDetails>
        );
      }
      case 'summary':
        return <Text key={key} style={[styles.paragraph, styles.strong]}>{renderHtmlNodes(node.children, true)}</Text>;
      case 'blockquote':
        return (
          <View key={key} style={[markdownStyles.blockquote, {backgroundColor: colors.neutralSoft, borderColor: colors.accentSoft}]}>
            {renderHtmlNodes(node.children)}
          </View>
        );
      case 'ul':
      case 'ol': {
        const ordered = node.tag === 'ol';
        const start = Number(node.attributes.start) || 1;
        return (
          <View key={key} style={markdownStyles.list}>
            {node.children.map((child, childIndex) =>
              child.type === 'element' && child.tag === 'li'
                ? renderHtmlListItem(child, childIndex, ordered, start, `li-${childIndex}`)
                : renderHtmlNode(child, childIndex, false),
            )}
          </View>
        );
      }
      case 'li':
        return renderHtmlListItem(node, index, false, 1, key);
      case 'table':
        return <View key={key} style={[markdownStyles.table, {borderColor: colors.border}]}>{renderHtmlNodes(node.children)}</View>;
      case 'thead':
      case 'tbody':
      case 'tfoot':
        return <React.Fragment key={key}>{renderHtmlNodes(node.children)}</React.Fragment>;
      case 'tr':
      case 'th':
      case 'td':
        return renderHtmlTablePart(node, key);
      case 'br':
        return <Text key={key}>{'\n'}</Text>;
      case 'hr':
        return <View key={key} style={[markdownStyles.hr, {backgroundColor: colors.border}]} />;
      case 'pre': {
        const codeNode = node.children.find(child => child.type === 'element' && child.tag === 'code');
        const language = codeNode?.type === 'element' ? codeNode.attributes.class?.match(/language-([^\s]+)/)?.[1] : undefined;
        return <MarkdownCodeBlock key={key} colors={colors} code={htmlTextContent(node)} language={language} />;
      }
      case 'code':
        return <Text key={key} style={styles.code}>{renderHtmlNodes(node.children, true)}</Text>;
      case 'kbd':
      case 'samp':
        return <Text key={key} style={styles.code}>{htmlTextContent(node)}</Text>;
      case 'strong':
      case 'b':
        return <Text key={key} style={styles.strong}>{renderHtmlNodes(node.children, true)}</Text>;
      case 'em':
      case 'i':
      case 'cite':
      case 'var':
        return <Text key={key} style={styles.emphasis}>{renderHtmlNodes(node.children, true)}</Text>;
      case 'del':
      case 's':
      case 'strike':
        return <Text key={key} style={styles.deleted}>{renderHtmlNodes(node.children, true)}</Text>;
      case 'u':
      case 'ins':
        return <Text key={key} style={markdownStyles.underline}>{renderHtmlNodes(node.children, true)}</Text>;
      case 'a':
        return (
          <Text
            key={key}
            onPress={() => onLinkPress(resolveUrl(node.attributes.href, 'link', baseUrl) ?? '')}
            style={styles.link}>
            {renderHtmlNodes(node.children, true)}
          </Text>
        );
      case 'img': {
        const uri = resolveUrl(node.attributes.src, 'image', baseUrl);
        if (!uri) return null;
        const width = Number(node.attributes.width);
        const height = Number(node.attributes.height);
        return (
          <MarkdownImage
            key={key}
            alt={node.attributes.alt}
            uri={uri}
            width={Number.isFinite(width) && width > 0 ? width : undefined}
            height={Number.isFinite(height) && height > 0 ? height : undefined}
          />
        );
      }
      case 'span':
      case 'small':
      case 'abbr':
      case 'time':
        return <React.Fragment key={key}>{renderHtmlNodes(node.children, true)}</React.Fragment>;
      default:
        return <React.Fragment key={key}>{renderHtmlNodes(node.children, inline)}</React.Fragment>;
    }
  };

  const renderHtmlNodes = (nodes: HtmlNode[], inline = false): React.ReactNode =>
    nodes.map((node, index) => renderHtmlNode(node, index, inline));

  const renderCode = (item: Tokens.Code) => (
    <MarkdownCodeBlock key={item.raw} colors={colors} code={item.text} language={item.lang} />
  );

  const renderListItem = (item: Tokens.ListItem, index: number, ordered: boolean, start: number) => (
    <View key={item.raw} style={markdownStyles.listItem}>
      {item.task ? (
        item.checked ? (
          <CheckCircle2 color={colors.success} size={14} />
        ) : (
          <Circle color={colors.muted} size={14} />
        )
      ) : ordered ? (
        <Text style={[markdownStyles.listMarker, {color: colors.muted}]}>{start + index}.</Text>
      ) : (
        <ChevronRight color={colors.muted} size={13} />
      )}
      <View style={markdownStyles.listContent}>{renderTokens(item.tokens)}</View>
    </View>
  );

  const renderTable = (item: Tokens.Table) => (
    <View key={item.raw} style={[markdownStyles.table, {borderColor: colors.border}]}>
      <View style={[markdownStyles.tableRow, {backgroundColor: colors.neutralSoft}]}>
        {item.header.map((cell, cellIndex) => (
          <View key={`header-${cellIndex}`} style={[markdownStyles.tableCell, {borderColor: colors.border}]}>
            <Text style={[markdownStyles.tableHeaderText, {color: colors.text}, {textAlign: cell.align ?? 'left'}]}>
              {renderInline(cell.tokens)}
            </Text>
          </View>
        ))}
      </View>
      {item.rows.map((row, rowIndex) => (
        <View key={row.map(cell => cell.text).join('|')} style={[markdownStyles.tableRow, rowIndex % 2 === 1 && {backgroundColor: colors.neutralSoft}]}>
          {row.map((cell, cellIndex) => (
            <View key={`${rowIndex}-${cellIndex}`} style={[markdownStyles.tableCell, {borderColor: colors.border}]}>
              <Text style={[markdownStyles.tableCellText, {color: colors.text}, {textAlign: cell.align ?? 'left'}]}>
                {renderInline(cell.tokens)}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );

  const renderToken = (item: Token, index: number): React.ReactNode => {
    switch (item.type) {
      case 'heading':
        return renderHeading(item as Tokens.Heading);
      case 'paragraph':
        return (
          <View key={item.raw} style={markdownStyles.inlineContainer}>
            {renderInlineBlock(item.tokens ?? [], styles.paragraph)}
          </View>
        );
      case 'code':
        return renderCode(item as Tokens.Code);
      case 'blockquote':
        return (
          <View key={item.raw} style={[markdownStyles.blockquote, {backgroundColor: colors.neutralSoft, borderColor: colors.accentSoft}]}>
            {renderTokens(item.tokens ?? [])}
          </View>
        );
      case 'list':
        return (
          <View key={item.raw} style={markdownStyles.list}>
            {(item as Tokens.List).items.map((listItem: Tokens.ListItem, itemIndex: number) =>
              renderListItem(listItem, itemIndex, (item as Tokens.List).ordered, Number((item as Tokens.List).start) || 1),
            )}
          </View>
        );
      case 'table':
        return renderTable(item as Tokens.Table);
      case 'hr':
        return <View key={item.raw} style={[markdownStyles.hr, {backgroundColor: colors.border}]} />;
      case 'html':
        return <React.Fragment key={`${item.raw}-${index}`}>{renderHtmlNodes(parseHtmlFragment(item.text))}</React.Fragment>;
      case 'text':
        return (
          <Text key={`${item.raw}-${index}`} style={styles.paragraph}>
            {renderInline(item.tokens ?? [])}
          </Text>
        );
      case 'space':
      case 'def':
        return null;
      default:
        return <React.Fragment key={index}>{renderTokens((item as Tokens.Generic).tokens ?? [])}</React.Fragment>;
    }
  };

  const renderTokens = (items: Token[]): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const container = item.type === 'html' ? openingBlockContainer(item.raw) : null;
      if (container) {
        const closeIndex = findMatchingBlockClose(items, index, container.tag);
        const endIndex = closeIndex >= 0 ? closeIndex : items.length;
        nodes.push(
          <View
            key={`container-${container.tag}-${index}`}
            style={[
              markdownStyles.htmlContainer,
              (htmlNodeAlign(container) === 'center' || container.tag === 'center') && markdownStyles.htmlCenter,
              htmlNodeAlign(container) === 'right' && markdownStyles.htmlRight,
            ]}>
            {renderTokens(items.slice(index + 1, endIndex))}
          </View>,
        );
        index = endIndex;
        continue;
      }
      nodes.push(renderToken(item, index));
    }

    return nodes;
  };

  return <View style={markdownStyles.container}>{renderTokens(tokens)}</View>;
}

const markdownStyles = StyleSheet.create({
  container: {gap: 12},
  heading: {fontWeight: '800', lineHeight: 24},
  heading1: {fontSize: 20, lineHeight: 28, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth},
  heading2: {fontSize: 17, lineHeight: 24, paddingBottom: 5, borderBottomWidth: StyleSheet.hairlineWidth},
  heading3: {fontSize: 15, lineHeight: 22},
  blockquote: {borderLeftWidth: 3, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8},
  list: {gap: 7},
  listItem: {flexDirection: 'row', alignItems: 'flex-start', gap: 6},
  listMarker: {fontSize: 13, lineHeight: 20, fontWeight: '700', minWidth: 18},
  listContent: {flex: 1, gap: 5},
  codeBlock: {borderWidth: 1, borderRadius: 8, padding: 10, gap: 6},
  codeScrollContent: {alignSelf: 'flex-start'},
  codeLanguage: {fontSize: 10, fontWeight: '700'},
  codeText: {fontFamily: 'monospace', fontSize: 12, lineHeight: 19},
  hr: {height: StyleSheet.hairlineWidth},
  table: {borderWidth: 1, borderRadius: 8, overflow: 'hidden'},
  tableRow: {flexDirection: 'row'},
  tableCell: {flex: 1, borderWidth: StyleSheet.hairlineWidth, borderTopWidth: 0, borderLeftWidth: 0, padding: 7},
  tableHeaderText: {fontSize: 11, fontWeight: '800'},
  tableCellText: {fontSize: 11, lineHeight: 17},
  inlineContainer: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6},
  inlineGroup: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4},
  htmlContainer: {gap: 10},
  htmlCenter: {alignItems: 'center'},
  htmlRight: {alignItems: 'flex-end'},
  image: {borderRadius: 8},
  figcaption: {textAlign: 'center'},
  underline: {textDecorationLine: 'underline'},
  details: {borderWidth: 1, borderRadius: 8, padding: 10},
  detailsHeader: {flexDirection: 'row', alignItems: 'center', gap: 6},
  detailsSummary: {flex: 1},
  detailsChevron: {transform: [{rotate: '-90deg'}]},
  detailsChevronExpanded: {transform: [{rotate: '0deg'}]},
  detailsContent: {marginTop: 8, gap: 10},
});
