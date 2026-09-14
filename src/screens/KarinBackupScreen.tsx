import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, AppState, BackHandler, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
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
  const active = Boolean(task && !['completed', 'failed', 'cancelled'].includes(task.phase));

  useEffect(() => subscribeBackup(setTask), []);
  useEffect(() => { refreshBackupTask().catch(() => {}); }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') refreshBackupTask().catch(() => {}); });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!active) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [active]);

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
        const conflictCount = Array.isArray((preview as {conflicts?: unknown} | null)?.conflicts)
          ? ((preview as {conflicts?: unknown[]}).conflicts?.length ?? 0)
          : 0;
        const conflictPaths = Array.isArray((preview as {conflicts?: unknown} | null)?.conflicts)
          ? ((preview as {conflicts?: unknown[]}).conflicts ?? []).filter((item): item is string => typeof item === 'string').slice(0, 8)
          : [];
        const conflictSummary = conflictCount > 0
          ? `\n重复文件：\n${conflictPaths.map(path => `· ${path}`).join('\n')}${conflictCount > conflictPaths.length ? `\n· 还有 ${conflictCount - conflictPaths.length} 个` : ''}`
          : '';
        const rootSummary = preview?.rootDir ? `\n来源目录：${preview.rootDir}` : '';
        Alert.alert(
          '确认导入 Karin',
          preview?.files
            ? `将导入 ${preview.files} 个文件，目标为容器 /root/karin。${rootSummary}\n检测到 ${conflictCount} 个重复文件。${conflictSummary}\n\n以下选择将应用到整个导入任务。`
            : '将导入 Karin 备份，目标为容器 /root/karin。以下选择将应用到整个导入任务的重复文件。',
          [
            {text: '取消', style: 'cancel', onPress: () => { clearBackupTask(); foregroundService.stop().catch(() => {}); }},
            {text: '全部保留当前文件', onPress: () => performImport(uri, false)},
            {text: '全部使用备份覆盖', style: 'destructive', onPress: () => performImport(uri, true)},
          ],
        );
      }
    } catch (error) {
      setTask({taskId: `error-${Date.now()}`, operation, phase: 'failed', progress: 0, logs: [backupErrorMessage(error)], error: backupErrorMessage(error)});
      await foregroundService.stop().catch(() => {});
    } finally { setBusy(false); }
  }, [active, busy, pluginListOnly, performImport]);

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

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回" disabled={active} onPress={onBack} style={styles.back}><ChevronLeft size={22} color={colors.text} /></Pressable>
        <Text style={[styles.title, {color: colors.text}]}>Karin 备份</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.intro, {color: colors.muted}]}>导出或导入 Karin 实例。备份始终排除 node_modules 与 @karinjs/logs，导入目标固定为容器 /root/karin。</Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1}, header: {paddingHorizontal: 14, paddingTop: 4, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 8}, back: {padding: 5}, title: {fontSize: 20, fontWeight: '800'}, content: {paddingHorizontal: 16, paddingBottom: 28, gap: 12}, intro: {fontSize: 12, lineHeight: 18}, card: {borderWidth: 1, borderRadius: 13, padding: 14, gap: 9}, cardTitle: {fontSize: 15, fontWeight: '800'}, cardText: {fontSize: 12, lineHeight: 18}, checkRow: {flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 3}, checkbox: {width: 20, height: 20, borderWidth: 1.5, borderRadius: 5, alignItems: 'center', justifyContent: 'center'}, check: {color: '#FFF', fontWeight: '900', fontSize: 14}, checkLabel: {fontSize: 13, fontWeight: '700'}, action: {minHeight: 48, borderRadius: 11, justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: 8}, actionText: {color: '#FFF', fontSize: 14, fontWeight: '800'}, taskCard: {borderWidth: 1, borderRadius: 13, padding: 14, gap: 10}, taskTitleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}, percent: {fontSize: 16, fontWeight: '900'}, progressTrack: {height: 8, borderRadius: 4, overflow: 'hidden'}, progressBar: {height: 8, borderRadius: 4}, phase: {fontSize: 11, fontWeight: '600'}, cancel: {height: 40, borderWidth: 1, borderRadius: 9, justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: 6}, cancelText: {fontSize: 12, fontWeight: '800'}, taskButtons: {flexDirection: 'row', gap: 8}, smallButton: {height: 38, borderRadius: 9, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: 6}, smallButtonText: {color: '#FFF', fontSize: 12, fontWeight: '800'},
});
