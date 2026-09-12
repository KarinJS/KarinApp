import {NativeModules} from 'react-native';

type NativeClipboard = {
  setString: (content: string) => void;
};

/** RN 0.87 已把 Clipboard 从核心移除（直接 import 会弹弃用警告），这里走原生模块本身。 */
const native = NativeModules.Clipboard as NativeClipboard | undefined;

/** 写入系统剪贴板；模块缺失时返回 false，由调用方提示失败。 */
export function setClipboardText(text: string): boolean {
  if (!native?.setString) return false;
  native.setString(text);
  return true;
}
