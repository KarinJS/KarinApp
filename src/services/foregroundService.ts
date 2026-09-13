import {NativeModules, PermissionsAndroid, Platform} from 'react-native';

/** Shizuku 三态：装没装、服务跑没跑、本 App 有没有被授权。 */
export type ShizukuStatus = {
  installed: boolean;
  running: boolean;
  granted: boolean;
};

const SHIZUKU_UNAVAILABLE: ShizukuStatus = {installed: false, running: false, granted: false};

type NativeForegroundService = {
  startForegroundService: () => Promise<string>;
  stopForegroundService: () => Promise<string>;
  isIgnoringBatteryOptimizations: () => Promise<boolean>;
  requestIgnoreBatteryOptimizations: () => Promise<boolean>;
  isRootAvailable: () => Promise<boolean>;
  applyRootKeepAlive: () => Promise<string>;
  getShizukuStatus: () => Promise<ShizukuStatus>;
  requestShizukuPermission: () => Promise<boolean>;
  applyShizukuKeepAlive: () => Promise<string>;
};

const native = NativeModules.KarinProot as NativeForegroundService;

export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Platform.Version < 33) return true;
  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (!permission) return true;
  const result = await PermissionsAndroid.request(permission);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export const foregroundService = {
  start: () => native.startForegroundService(),
  stop: () => native.stopForegroundService(),
  /** App 是否在电池优化白名单里；不在时 Doze 会冻结 CPU、节流网络，容器内 node 会被暂停。 */
  isIgnoringBatteryOptimizations: () => native.isIgnoringBatteryOptimizations().catch(() => false),
  /** 拉起系统授权弹窗；用户选择结果由系统记住，下次 isIgnoringBatteryOptimizations 生效。 */
  requestIgnoreBatteryOptimizations: () => native.requestIgnoreBatteryOptimizations().catch(() => false),
  /** 设备是否有可用的 root（su 能以 uid=0 执行命令）。 */
  isRootAvailable: () => native.isRootAvailable().catch(() => false),
  /** Root 写入系统保活白名单；返回逐条命令的执行结果文本。 */
  applyRootKeepAlive: () => native.applyRootKeepAlive(),
  /** Shizuku 状态；Shizuku 未安装或原生模块不可用时按不可用处理。 */
  shizukuStatus: () => native.getShizukuStatus().catch(() => SHIZUKU_UNAVAILABLE),
  /** 拉起 Shizuku 授权弹窗，resolve 用户是否授权（无人理会时超时按 false）。 */
  requestShizukuPermission: () => native.requestShizukuPermission().catch(() => false),
  /** 借 Shizuku 的 adb 身份写入系统保活白名单；返回逐条命令的执行结果文本。 */
  applyShizukuKeepAlive: () => native.applyShizukuKeepAlive(),
};
