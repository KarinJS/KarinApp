/** lowlight 1.x 与 highlight.js 10 的语言包都没有自带 TS 类型，这里补最小声明。 */
declare module 'lowlight/lib/core' {
  export type HastTextNode = {type: 'text'; value: string};
  export type HastElementNode = {
    type: 'element';
    tagName: string;
    properties?: {className?: string[]};
    children?: HastNode[];
  };
  export type HastNode = HastTextNode | HastElementNode;
  export function registerLanguage(name: string, syntax: unknown): void;
  export function highlight(
    language: string,
    value: string,
    options?: {prefix?: string},
  ): {value: HastNode[]};
}

declare module 'highlight.js/lib/languages/*' {
  const language: unknown;
  export default language;
}
