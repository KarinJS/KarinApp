import {NativeModules} from 'react-native';

export type ImportedAppPlugin = {
  /** 落地到容器里的文件名（取自系统文件选择器给的显示名） */
  name: string;
  size: number;
};

type NativeAppPluginImport = {
  pickFile: (relativeDir: string) => Promise<ImportedAppPlugin | null>;
};

/** 原生层负责把选中的文件复制进 rootfs；旧版本 App 没有这个方法 */
const native = NativeModules.KarinAppPluginImport as NativeAppPluginImport | undefined;

export const canImportLocalAppPlugin = () => Boolean(native?.pickFile);

/**
 * 让用户从系统文件选择器挑一个 app 插件文件，复制进容器的 relativeDir（相对 rootfs 根，例如
 * root/karin/plugins/karin-plugin-example）。用户取消时返回 null。
 */
export const importLocalAppPlugin = (relativeDir: string): Promise<ImportedAppPlugin | null> => {
  if (!native?.pickFile) return Promise.reject(new Error('当前版本不支持从本地文件导入，请更新 App 后重试'));
  return native.pickFile(relativeDir);
};