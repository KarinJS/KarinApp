/** Metro 把图片当作资源模块处理，import 结果是资源 id；这里补最小声明供 TS 使用。 */
declare module '*.png' {
  const source: number;
  export default source;
}

declare module '*.jpg' {
  const source: number;
  export default source;
}

declare module '*.jpeg' {
  const source: number;
  export default source;
}

declare module '*.webp' {
  const source: number;
  export default source;
}
