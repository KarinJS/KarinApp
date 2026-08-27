import {NativeModules} from 'react-native';

type KarinLogModule = {
  saveStartupLog: (content: string) => Promise<string>;
  openLogLocation: () => Promise<boolean>;
};

const native = NativeModules.KarinLog as KarinLogModule | undefined;

/** 将启动日志保存到公共 Download 目录，返回用于展示的路径。 */
export async function saveStartupLog(content: string): Promise<string> {
  if (!native || typeof native.saveStartupLog !== 'function') {
    throw new Error('KarinLog 原生模块不可用，请重新编译安装应用');
  }
  return native.saveStartupLog(content);
}

/** 打开日志文件所在位置；无可用文件管理器时返回 false。 */
export async function openLogLocation(): Promise<boolean> {
  if (!native || typeof native.openLogLocation !== 'function') {
    return false;
  }
  return native.openLogLocation();
}
