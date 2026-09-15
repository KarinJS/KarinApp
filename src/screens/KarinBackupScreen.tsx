import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, AppState, BackHandler, Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {ChevronLeft, Download, RotateCcw, Trash2, Upload} from 'lucide-react-native';
import LogConsole from '../components/LogConsole';
import {requestNotificationPermission, foregroundService} from '../services/foregroundService';
import {karinService} from '../services/karinService';
import {
  BackupTask,
  backupErrorMessage,
  cancelBackupTask,
  clearBackupTask,
  discardBackupTask,
  importBackupUri,
  inspectBackupImport,
  pickBackupImport,
  refreshBackupTask,
  resumeBackupTask,
  startBackupExport,
  subscribeBackup,
} from '../services/karinBackupService';
import {Colors} from '../theme/colors';

type Props = {colors: Colors; onBack: () => void};
type ImportConfirmation = {uri: string; message: string};

const phaseLabel: Record<string, string> = {
  picking: '等待选择文件', validating: '校验备份', scanning: '扫描 Karin 文件', staging: '准备导入',
  committing: '写入 Karin', installing: '安装依赖', cloning: '克隆 Git 插件', completed: '已完成', failed: '失败', cancelled: '已取消', paused: '已暂停',
};

const formatBytes = (bytes?: number) => {
  if (!bytes || bytes <= 0) return '';
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

export default function KarinBackupScreen({colors, onBack}: Props) {
  const [task, setTask] = useState<BackupTask | null>(null);
  const [pluginListOnly, setPluginListOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importConfirmation, setImportConfirmation] = useState<ImportConfirmation | null>(null);
  const active = Boolean(task && !['completed', 'failed', 'cancelled'].includes(task.phase));

  useEffect(() => subscribeBackup(setTask), []);
  useEffect(() => { refreshBackupTask().catch(() => {}); }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') refreshBackupTask().catch(() => {}); });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    // 接管系统返回手势：任务进行中暂不允许离开，空闲时返回设置页。
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (active) return true;
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [active, onBack]);

  const percent = typeof task?.progress === 'number' && task.progress >= 0 ? Math.round(task.progress * 100) : 0;
  const detail = useMemo(() => {
    if (!task) return '导出 Karin 的配置、数据与插件';
    const phase = phaseLabel[task.phase] ?? task.phase;
    const file = task.totalFiles ? ` · ${task.completedFiles ?? 0}/${task.totalFiles} 个文件` : '';
    const size = task.totalBytes ? ` · ${formatBytes(task.completedBytes)} / ${formatBytes(task.totalBytes)}` : '';
    return `${phase}${file}${size}`;
  }, [task]);

  const ensureNotification = async () => {
    const allowed = await requestNotificationPermission();
    if (!allowed) {
      Alert.alert('需要通知权限', '导入或导出可在后台继续，通知权限用于显示实时进度。未授权时请保持本页打开。', [{text: '继续', style: 'default'}]);
    }
    return allowed;
  };

  const performImport = useCallback(async (uri: string, overwrite: boolean) => {
    setBusy(true);
    const karinWasRunning = (await karinService.probe()).running;
    try {
      if (karinWasRunning) await karinService.stop();
      await importBackupUri(uri, overwrite);
    } catch (error) {
      setTask({taskId: `error-${Date.now()}`, operation: 'import', phase: 'failed', progress: 0, logs: [backupErrorMessage(error)], error: backupErrorMessage(error)});
    } finally {
      if (karinWasRunning) await karinService.start().catch(() => {});
      setBusy(false);
      await foregroundService.stop().catch(() => {});
    }
  }, []);

  const run = useCallback(async (operation: 'export' | 'import') => {
    if (busy || active) return;
    setBusy(true);
    try {
      await ensureNotification();
      await foregroundService.start().catch(() => {});
      if (operation === 'export') {
        const karinWasRunning = (await karinService.probe()).running;
        try {
          if (karinWasRunning) await karinService.stop();
          const result = await startBackupExport({pluginListOnly});
          if (!result) await foregroundService.stop().catch(() => {});
        } finally {
          if (karinWasRunning) await karinService.start().catch(() => {});
        }
      } else {
        const uri = await pickBackupImport();
        if (!uri) { await foregroundService.stop().catch(() => {}); return; }
        const preview = await inspectBackupImport(uri);
        const message = preview?.files
          ? `将导入 ${preview.files} 个文件。`
          : '将导入 Karin 备份。';
        setImportConfirmation({uri, message});
      }
    } catch (error) {
      setTask({taskId: `error-${Date.now()}`, operation, phase: 'failed', progress: 0, logs: [backupErrorMessage(error)], error: backupErrorMessage(error)});
      await foregroundService.stop().catch(() => {});
    } finally { setBusy(false); }
  }, [active, busy, pluginListOnly]);

  useEffect(() => {
    if (task && ['completed', 'failed', 'cancelled'].includes(task.phase)) foregroundService.stop().catch(() => {});
  }, [task]);

  const onCancel = () => {
    if (!task) return;
    Alert.alert('取消导入？', '将删除尚未提交的文件，并回滚已经替换的文件。', [
      {text: '继续导入', style: 'cancel'},
      {text: '取消并清理', style: 'destructive', onPress: () => cancelBackupTask(task.taskId).catch(error => Alert.alert('取消失败', backupErrorMessage(error)))},
    ]);
  };
  const onDiscard = () => {
    if (!task) return;
    discardBackupTask(task.taskId).then(() => setTask(null)).catch(error => Alert.alert('清理失败', backupErrorMessage(error)));
  };
  const onResume = () => {
    if (!task) return;
    resumeBackupTask(task.taskId).catch(error => Alert.alert('无法继续导入', backupErrorMessage(error)));
  };
  const cancelImportConfirmation = () => {
    setImportConfirmation(null);
    clearBackupTask();
    foregroundService.stop().catch(() => {});
  };
  const confirmImport = (overwrite: boolean) => {
    if (!importConfirmation) return;
    const {uri} = importConfirmation;
    setImportConfirmation(null);
    performImport(uri, overwrite);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回" disabled={active} onPress={onBack} style={styles.back}><ChevronLeft size={22} color={colors.text} /></Pressable>
        <Text style={[styles.title, {color: colors.text}]}>Karin 备份</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.intro, {color: colors.muted}]}>导出或导入 Karin 实例。备份始终排除 node_modules 与 @karinjs/logs。</Text>
        {!task ? <>
          <View style={[styles.card, {backgroundColor: colors.surface, borderColor: colors.border}]}>
            <Text style={[styles.cardTitle, {color: colors.text}]}>导出范围</Text>
            <Text style={[styles.cardText, {color: colors.muted}]}>勾选后，Git 插件只记录仓库地址、分支和 commit；本地插件与 APP 插件仍会完整备份。</Text>
            <Pressable onPress={() => setPluginListOnly(value => !value)} style={styles.checkRow}>
              <View style={[styles.checkbox, {borderColor: pluginListOnly ? colors.accent : colors.border, backgroundColor: pluginListOnly ? colors.accent : 'transparent'}]}>{pluginListOnly ? <Text style={styles.check}>✓</Text> : null}</View>
              <Text style={[styles.checkLabel, {color: colors.text}]}>仅备份插件列表</Text>
            </Pressable>
          </View>
          <Pressable disabled={busy} onPress={() => run('export')} style={[styles.action, {backgroundColor: colors.accent, opacity: busy ? 0.65 : 1}]}><Download size={18} color="#FFFFFF" /><Text style={styles.actionText}>{busy ? '准备导出…' : '导出 Karin 备份'}</Text></Pressable>
          <Pressable disabled={busy} onPress={() => run('import')} style={[styles.action, {backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, opacity: busy ? 0.65 : 1}]}><Upload size={18} color={colors.text} /><Text style={[styles.actionText, {color: colors.text}]}>导入 Karin 备份</Text></Pressable>
        </> : <View style={[styles.taskCard, {backgroundColor: colors.surface, borderColor: colors.border}]}>
          <View style={styles.taskTitleRow}><Text style={[styles.cardTitle, {color: colors.text}]}>{task.operation === 'import' ? '正在导入 Karin' : '正在导出 Karin'}</Text><Text style={[styles.percent, {color: colors.accent}]}>{percent}%</Text></View>
          <Text style={[styles.cardText, {color: colors.muted}]}>{task.current || task.message || detail}</Text>
          <View style={[styles.progressTrack, {backgroundColor: colors.neutralSoft}]}><View style={[styles.progressBar, {backgroundColor: colors.accent, width: `${Math.max(0, Math.min(100, percent))}%`}]} /></View>
          <Text style={[styles.phase, {color: colors.muted}]}>{detail}</Text>
          {active ? <Pressable onPress={onCancel} style={[styles.cancel, {borderColor: colors.danger}]}><Trash2 size={15} color={colors.danger} /><Text style={[styles.cancelText, {color: colors.danger}]}>取消并清理任务</Text></Pressable> : <View style={styles.taskButtons}>{task.phase === 'paused' ? <Pressable onPress={onResume} style={[styles.smallButton, {backgroundColor: colors.accent}]}><RotateCcw size={15} color="#FFF" /><Text style={styles.smallButtonText}>继续导入</Text></Pressable> : null}<Pressable onPress={onDiscard} style={[styles.smallButton, {backgroundColor: colors.neutralSoft}]}><Trash2 size={15} color={colors.text} /><Text style={[styles.smallButtonText, {color: colors.text}]}>清理记录</Text></Pressable></View>}
        </View>}
        {task ? <LogConsole logs={task.logs} colors={colors} maxHeight={320} placeholder="等待任务日志…" /> : null}
      </ScrollView>
      <Modal transparent visible={importConfirmation !== null} animationType="fade" onRequestClose={cancelImportConfirmation}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, {backgroundColor: colors.surface}]}>
            <Text style={[styles.modalTitle, {color: colors.text}]}>确认导入 Karin</Text>
            <Text style={[styles.modalBody, {color: colors.muted}]}>{importConfirmation?.message}</Text>
            <View style={styles.modalActions}>
              <Pressable onPress={cancelImportConfirmation} style={[styles.modalButton, {borderColor: colors.border}]}>
                <Text style={[styles.modalButtonText, {color: colors.text}]}>取消</Text>
              </Pressable>
              <Pressable onPress={() => confirmImport(true)} style={[styles.modalButton, {backgroundColor: colors.accent, borderColor: colors.accent}]}>
                <Text style={styles.modalPrimaryText}>导入</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1}, header: {paddingHorizontal: 14, paddingTop: 4, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 8}, back: {padding: 5}, title: {fontSize: 20, fontWeight: '800'}, content: {paddingHorizontal: 16, paddingBottom: 28, gap: 12}, intro: {fontSize: 12, lineHeight: 18}, card: {borderWidth: 1, borderRadius: 13, padding: 14, gap: 9}, cardTitle: {fontSize: 15, fontWeight: '800'}, cardText: {fontSize: 12, lineHeight: 18}, checkRow: {flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 3}, checkbox: {width: 20, height: 20, borderWidth: 1.5, borderRadius: 5, alignItems: 'center', justifyContent: 'center'}, check: {color: '#FFF', fontWeight: '900', fontSize: 14}, checkLabel: {fontSize: 13, fontWeight: '700'}, action: {minHeight: 48, borderRadius: 11, justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: 8}, actionText: {color: '#FFF', fontSize: 14, fontWeight: '800'}, taskCard: {borderWidth: 1, borderRadius: 13, padding: 14, gap: 10}, taskTitleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}, percent: {fontSize: 16, fontWeight: '900'}, progressTrack: {height: 8, borderRadius: 4, overflow: 'hidden'}, progressBar: {height: 8, borderRadius: 4}, phase: {fontSize: 11, fontWeight: '600'}, cancel: {height: 40, borderWidth: 1, borderRadius: 9, justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: 6}, cancelText: {fontSize: 12, fontWeight: '800'}, taskButtons: {flexDirection: 'row', gap: 8}, smallButton: {height: 38, borderRadius: 9, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: 6}, smallButtonText: {color: '#FFF', fontSize: 12, fontWeight: '800'}, modalBackdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.46)', alignItems: 'center', justifyContent: 'center', padding: 24}, modalCard: {width: '100%', borderRadius: 16, padding: 20}, modalTitle: {fontSize: 20, fontWeight: '800'}, modalBody: {fontSize: 13, lineHeight: 19, marginTop: 8}, modalActions: {flexDirection: 'row', gap: 8, marginTop: 22}, modalButton: {flex: 1, minHeight: 42, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5}, modalButtonText: {fontSize: 12, fontWeight: '700'}, modalPrimaryText: {color: '#FFF', fontSize: 12, fontWeight: '700'},
});
