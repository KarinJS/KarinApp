import React, {useCallback, useEffect, useState} from 'react';
import {AppState, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {PermissionsAndroid} from 'react-native';
import {
  Bell,
  BatteryCharging,
  ChevronLeft,
  Copy,
  ShieldCheck,
  Terminal,
  TriangleAlert,
} from 'lucide-react-native';
import {foregroundService} from '../services/foregroundService';
import {setClipboardText} from '../services/clipboardService';
import {useToast} from '../hooks/useToast';
import Toast from '../components/Toast';
import {Colors} from '../theme/colors';

type Props = {
  colors: Colors;
  onBack: () => void;
};

const PACKAGE_NAME = 'com.karinjs.karin';
/** 没有 root 时引导用户用 PC adb（或 Shizuku）执行同样的白名单命令。 */
const ADB_COMMANDS = [
  `adb shell dumpsys deviceidle whitelist +${PACKAGE_NAME}`,
  `adb shell cmd appops set ${PACKAGE_NAME} RUN_ANY_IN_BACKGROUND allow`,
  `adb shell cmd appops set ${PACKAGE_NAME} START_FOREGROUND allow`,
];

type CheckState = 'checking' | 'granted' | 'denied';

/**
 * 保活设置：集中检查/引导保活相关权限。启动 Karin 只主动申请通知权限，
 * 其余项由用户在这里按需开启，避免一启动就弹一串授权。
 */
export default function KeepAliveScreen({colors, onBack}: Props) {
  const [notification, setNotification] = useState<CheckState>('checking');
  const [battery, setBattery] = useState<CheckState>('checking');
  const [rootAvailable, setRootAvailable] = useState<boolean | null>(null);
  const [rootApplying, setRootApplying] = useState(false);
  const {notice, showNotice} = useToast();

  /** 系统弹窗回来后要重读状态；App 切回前台（含用户从系统设置返回）也重读。 */
  const refresh = useCallback(() => {
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
      .then(granted => setNotification(granted ? 'granted' : 'denied'))
      .catch(() => setNotification('denied'));
    foregroundService.isIgnoringBatteryOptimizations().then(granted => setBattery(granted ? 'granted' : 'denied'));
    foregroundService.isRootAvailable().then(setRootAvailable);
  }, []);

  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const requestNotification = () => {
    PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
      .then(() => refresh())
      .catch(() => {});
  };

  const requestBattery = () => {
    foregroundService.requestIgnoreBatteryOptimizations().then(() => refresh());
  };

  const applyRoot = () => {
    if (rootApplying) return;
    setRootApplying(true);
    foregroundService
      .applyRootKeepAlive()
      .then(() => {
        showNotice('已写入系统保活白名单');
        refresh();
      })
      .catch(() => showNotice('写入失败，请在 su 弹窗中授予 root 权限', 5000))
      .finally(() => setRootApplying(false));
  };

  const copyAdbCommands = () => {
    if (!setClipboardText(ADB_COMMANDS.join('\n'))) {
      showNotice('复制失败：剪贴板不可用', 5000);
      return;
    }
    showNotice('已复制 adb 命令');
  };

  const statusBadge = (state: CheckState) => {
    const granted = state === 'granted';
    return (
      <View style={[styles.badge, {backgroundColor: state === 'checking' ? colors.neutralSoft : granted ? colors.successSoft : colors.neutralSoft}]}>
        <Text style={[styles.badgeText, {color: state === 'checking' ? colors.muted : granted ? colors.success : colors.muted}]}>
          {state === 'checking' ? '检测中' : granted ? '已授权' : '未授权'}
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, {borderBottomColor: colors.border}]}>
        <Pressable onPress={onBack} style={styles.headerButton} accessibilityLabel="返回">
          <ChevronLeft size={20} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, {color: colors.text}]}>保活设置</Text>
        <View style={styles.headerButton} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.intro, {color: colors.muted}]}>
          锁屏后系统会冻结 CPU、节流网络，容器里的 Karin 会被暂停。开启以下权限能最大程度保持后台实时运行。
        </Text>

        <View style={[styles.list, {backgroundColor: colors.surface, borderColor: colors.border}]}>
          <Pressable onPress={notification === 'granted' ? undefined : requestNotification} style={[styles.row, styles.rowDivider, {borderBottomColor: colors.border}]}>
            <View style={styles.copy}>
              <View style={styles.labelRow}>
                <Bell size={14} color={colors.muted} />
                <Text style={[styles.label, {color: colors.text}]}>通知权限</Text>
              </View>
              <Text style={[styles.value, {color: colors.muted}]}>
                前台服务通知的展示授权，Karin 启动时会主动申请
              </Text>
            </View>
            {statusBadge(notification)}
          </Pressable>

          <Pressable onPress={battery === 'granted' ? undefined : requestBattery} style={[styles.row, styles.rowDivider, {borderBottomColor: colors.border}]}>
            <View style={styles.copy}>
              <View style={styles.labelRow}>
                <BatteryCharging size={14} color={colors.muted} />
                <Text style={[styles.label, {color: colors.text}]}>电池优化白名单</Text>
              </View>
              <Text style={[styles.value, {color: colors.muted}]}>
                加入白名单后系统不再限制本 App 的后台 CPU 与网络
              </Text>
            </View>
            {statusBadge(battery)}
          </Pressable>

          <View style={styles.row}>
            <View style={styles.copy}>
              <View style={styles.labelRow}>
                <Terminal size={14} color={colors.muted} />
                <Text style={[styles.label, {color: colors.text}]}>ADB / Root 保活</Text>
              </View>
              <Text style={[styles.value, {color: colors.muted}]}>
                {rootAvailable === null
                  ? '检测中…'
                  : rootAvailable
                    ? '已检测到 root，可一键写入系统白名单'
                    : '没有 root 时可复制命令用 PC adb 执行'}
              </Text>
            </View>
            {rootAvailable === null ? null : rootAvailable ? (
              <Pressable
                onPress={applyRoot}
                disabled={rootApplying}
                style={[styles.actionButton, {backgroundColor: colors.accent}]}
                accessibilityLabel="Root 一键保活">
                <Text style={styles.actionButtonTextAccent}>{rootApplying ? '写入中…' : '一键保活'}</Text>
              </Pressable>
            ) : (
              <Pressable onPress={copyAdbCommands} style={[styles.actionButton, {backgroundColor: colors.neutralSoft}]} accessibilityLabel="复制 adb 命令">
                <Copy size={14} color={colors.text} />
                <Text style={[styles.actionButtonText, {color: colors.text}]}>复制命令</Text>
              </Pressable>
            )}
          </View>
        </View>

        {!rootAvailable ? (
          <View style={[styles.commandBlock, {backgroundColor: colors.surface, borderColor: colors.border}]}>
            <Text style={[styles.commandTitle, {color: colors.muted}]}>在电脑上连接手机后依次执行：</Text>
            {ADB_COMMANDS.map(command => (
              <Text key={command} style={[styles.commandText, {color: colors.text}]}>
                {command}
              </Text>
            ))}
          </View>
        ) : null}

        <View style={[styles.note, {backgroundColor: colors.surface, borderColor: colors.border}]}>
          <View style={styles.labelRow}>
            <ShieldCheck size={14} color={colors.muted} />
            <Text style={[styles.label, {color: colors.text}]}>Root 保活做了什么</Text>
          </View>
          <Text style={[styles.noteText, {color: colors.muted}]}>
            把 Karin App 加入系统的 deviceidle 白名单（与「电池优化白名单」等效，但不弹授权框），
            并放开后台运行、前台服务的 appops 限制，效果优于手动授权。
          </Text>
          <View style={[styles.labelRow, styles.noteGap]}>
            <TriangleAlert size={14} color={colors.muted} />
            <Text style={[styles.label, {color: colors.text}]}>厂商 ROM 提示</Text>
          </View>
          <Text style={[styles.noteText, {color: colors.muted}]}>
            小米、华为等系统有自带的省电策略，标准权限拦不住：还需在系统设置里给 Karin App
            开「自启动」、把省电策略设为「无限制」，否则锁屏后仍可能被冻结。
          </Text>
        </View>
      </ScrollView>

      {notice ? <Toast message={notice} colors={colors} bottomOffset={64} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  header: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1},
  headerButton: {width: 34, height: 34, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 15, fontWeight: '800', flex: 1},
  content: {paddingHorizontal: 16, paddingTop: 14, paddingBottom: 28},
  intro: {fontSize: 12, lineHeight: 18, marginBottom: 12},
  list: {borderWidth: 1, borderRadius: 13, overflow: 'hidden'},
  row: {minHeight: 62, paddingHorizontal: 15, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10},
  rowDivider: {borderBottomWidth: StyleSheet.hairlineWidth},
  copy: {flex: 1, gap: 4},
  labelRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  label: {fontSize: 14, fontWeight: '700'},
  value: {fontSize: 11, fontWeight: '600', lineHeight: 16},
  badge: {borderRadius: 10, paddingHorizontal: 9, paddingVertical: 4},
  badgeText: {fontSize: 11, fontWeight: '700'},
  actionButton: {borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 5},
  actionButtonText: {fontSize: 12, fontWeight: '700'},
  actionButtonTextAccent: {fontSize: 12, fontWeight: '700', color: '#FFFFFF'},
  commandBlock: {borderWidth: 1, borderRadius: 13, marginTop: 12, padding: 12, gap: 6},
  commandTitle: {fontSize: 11, fontWeight: '600'},
  commandText: {fontSize: 11, fontFamily: 'monospace'},
  note: {borderWidth: 1, borderRadius: 13, marginTop: 12, padding: 12, gap: 6},
  noteGap: {marginTop: 8},
  noteText: {fontSize: 11, lineHeight: 16},
});
