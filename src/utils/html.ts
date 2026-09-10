export type HtmlElementNode = {type: 'element'; tag: string; attributes: Record<string, string>; children: HtmlNode[]};
export type HtmlNode = {type: 'text'; text: string} | HtmlElementNode;

const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const tagPattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^\u0022>']|\u0022[^\u0022]*\u0022|'[^']*')*)>/g;
const attributePattern = /([^\s=]+)(?:\s*=\s*(?:\u0022([^\u0022]*)\u0022|'([^']*)'|([^\s\u0022'>]+)))?/g;
const namedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '\u0022',
  apos: '\u0027',
  nbsp: ' ',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z\d]+));/gi, (match, hex, decimal, name) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(parseInt(decimal, 10));
    return namedEntities[name.toLowerCase()] ?? match;
  });
}

function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  attributePattern.lastIndex = 0;
  let match = attributePattern.exec(value);
  while (match) {
    attributes[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
    match = attributePattern.exec(value);
  }
  return attributes;
}

export function parseHtmlFragment(value: string): HtmlNode[] {
  const root: HtmlElementNode = {type: 'element', tag: '', attributes: {}, children: []};
  const stack: HtmlElementNode[] = [root];
  let cursor = 0;
  const appendText = (text: string) => {
    if (!text) return;
    stack[stack.length - 1].children.push({type: 'text', text: decodeHtmlEntities(text)});
  };

  tagPattern.lastIndex = 0;
  let match = tagPattern.exec(value);
  while (match) {
    appendText(value.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (!match[0].startsWith('<!--')) {
      const tag = match[1].toLowerCase();
      if (match[0].startsWith('</')) {
        for (let index = stack.length - 1; index > 0; index -= 1) {
          if (stack[index].tag === tag) {
            const unclosed = stack.splice(index);
            for (let nested = unclosed.length - 1; nested > 0; nested -= 1) {
              unclosed[nested - 1].children.push(unclosed[nested]);
            }
            const closed = unclosed[0];
            stack[stack.length - 1].children.push(closed);
            break;
          }
        }
      } else {
        const element: HtmlElementNode = {type: 'element', tag, attributes: parseAttributes(match[2] ?? ''), children: []};
        if (!match[0].endsWith('/>') && !voidTags.has(tag)) stack.push(element);
        else stack[stack.length - 1].children.push(element);
      }
    }
    match = tagPattern.exec(value);
  }

  appendText(value.slice(cursor));
  while (stack.length > 1) {
    const element = stack.pop();
    if (element) stack[stack.length - 1].children.push(element);
  }
  return root.children;
}

export function htmlTextContent(node: HtmlNode): string {
  if (node.type === 'text') return node.text;
  if (node.tag === 'script' || node.tag === 'style') return '';
  return node.children.map(htmlTextContent).join('');
}
