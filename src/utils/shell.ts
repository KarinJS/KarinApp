/** 用单引号包裹 shell 参数并转义其中的单引号，避免拼接命令时被截断或注入。 */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
