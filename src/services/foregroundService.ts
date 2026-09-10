import {NativeModules, PermissionsAndroid, Platform} from 'react-native';

type NativeForegroundService = {
  startForegroundService: () => Promise<string>;
  stopForegroundService: () => Promise<string>;
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
};
