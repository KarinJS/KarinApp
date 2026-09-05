import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {Power} from 'lucide-react-native';
import BottomNav from './components/BottomNav';
import ConfirmDialog from './components/ConfirmDialog';
import RestartDialog from './components/RestartDialog';
import StartupScreen from './components/StartupScreen';
import Toast from './components/Toast';
import VersionSheet from './components/VersionSheet';
import {useContainerStatus} from './hooks/useContainerStatus';
import {useKarinRuntime} from './hooks/useKarinRuntime';
import {useToast} from './hooks/useToast';
import DashboardScreen from './screens/DashboardScreen';
import FileManagerScreen from './screens/FileManagerScreen';
import PluginsScreen from './screens/PluginsScreen';
import SettingsScreen from './screens/SettingsScreen';
import {karinService} from './services/karinService';
import {prootController} from './services/prootController';
import {inspectEnvironment, switchKarinVersion} from './services/environmentService';
import {openLogLocation, saveStartupLog} from './services/logService';
import {getStartupLog, resetContainerEnvironment, resetKarinProjectEnvironment, runStartupTasks} from './startup/startupTasks';
import type {StartupProgress} from './startup/startupTasks';
import {useAppColors} from './theme/colors';
import type {Tab} from './types';

const INITIAL_STARTUP: StartupProgress = {
  stage: 'container',
  message: '正在准备 Karin',
  progress: 0,
  logs: [],
};

export default function App() {
  const {colors, dark} = useAppColors();
  const {notice, showNotice} = useToast();
  const {containerState, setContainerState} = useContainerStatus();
  const {
    running: karinRunning,
    seconds: karinSeconds,
    memoryBytes: karinMemoryBytes,
  } = useKarinRuntime(containerState === 'running');

  const [startup, setStartup] = useState<StartupProgress>(INITIAL_STARTUP);
  const [startupDone, setStartupDone] = useState(false);
  const [startupError, setStartupError] = useState('');
  const [startupLogPath, setStartupLogPath] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('控制台');
  const [restartOpen, setRestartOpen] = useState(false);
  const [karinVersion, setKarinVersion] = useState('');
  const [versionOpen, setVersionOpen] = useState(false);
  const [versionBusy, setVersionBusy] = useState(false);
  const [containerBusy, setContainerBusy] = useState(false);
  const [karinBusy, setKarinBusy] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [resetConfirm, setResetConfirm] = useState<'project' | 'container' | null>(null);
  const [resetProgress, setResetProgress] = useState<StartupProgress | null>(null);
  const [resetError, setResetError] = useState('');

  const refreshKarinVersion = () =>
    inspectEnvironment()
      .then(env => setKarinVersion(env.karin))
      .catch(() => {});

  const boot = () => {
    setStartupError('');
    setStartupLogPath('');
    setStartupDone(false);
    runStartupTasks(setStartup)
      .then(async () => {
        setContainerState('running');
        setStartupDone(true);
        refreshKarinVersion();
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : '启动准备失败';
        setStartupError(message);
        const fullLog = `${getStartupLog()}\n[失败] ${message}`;
        saveStartupLog(fullLog)
          .then(path => setStartupLogPath(path))
          .catch(() => setStartupLogPath(''));
      });
  };
  const handleOpenLogLocation = async () => {
    try {
      const opened = await openLogLocation();
      if (!opened) showNotice('无法打开日志文件位置');
    } catch {
      showNotice('无法打开日志文件位置');
    }
  };

  useEffect(() => {
    boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRestart = async (force: boolean) => {
    if (containerBusy) {
      return;
    }
    setContainerBusy(true);
    setRestartOpen(false);
    setContainerState('starting');
    try {
      await prootController.stop(force);
      await prootController.start();
      setContainerState('running');
      showNotice(force ? '容器已强制重启' : '容器已优雅重启');
    } catch (error) {
      setContainerState('stopped');
      showNotice(`容器启动失败: ${String(error)}`);
    } finally {
      setContainerBusy(false);
    }
  };

  const handleKarinToggle = async () => {
    if (karinBusy) {
      return;
    }
    setKarinBusy(true);
    try {
      if (karinRunning) {
        await karinService.stop();
        showNotice('Karin 已停止');
      } else {
        await karinService.start();
        showNotice('Karin 已启动');
      }
    } catch (error) {
      showNotice(`操作失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setKarinBusy(false);
    }
  };

  const handleReset = async () => {
    const kind = resetConfirm;
    if (!kind) {
      return;
    }
    setResetConfirm(null);
    setResetError('');
    setResetProgress({
      stage: 'environment',
      message: kind === 'project' ? '正在重置 Karin 项目' : '正在重置容器',
      progress: 0,
      logs: [],
    });
    try {
      if (karinRunning) {
        await karinService.stop().catch(() => {});
      }
      if (kind === 'project') {
        await resetKarinProjectEnvironment(setResetProgress);
      } else {
        setContainerState('starting');
        await resetContainerEnvironment(setResetProgress);
        setContainerState('running');
      }
      setResetProgress(null);
      refreshKarinVersion();
      showNotice(kind === 'project' ? 'Karin 项目已重置' : '容器已重置');
    } catch (error) {
      if (kind === 'container') {
        setContainerState('stopped');
      }
      setResetError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleVersionConfirm = async (version: string) => {
    if (versionBusy) {
      return;
    }
    setVersionBusy(true);
    try {
      await switchKarinVersion(version, () => {});
      setKarinVersion(version);
      setVersionOpen(false);
      showNotice(`Karin 已切换到 v${version}`);
    } catch (error) {
      showNotice(`版本切换失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setVersionBusy(false);
    }
  };

  const powerButtonStyle = {
    backgroundColor: karinRunning ? colors.powerActive : colors.surface,
    borderColor: karinRunning ? colors.powerActiveBorder : colors.border,
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.safe, {backgroundColor: colors.background}]} edges={['top', 'bottom']}>
        <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />

        {!startupDone ? (
          <StartupScreen
            colors={colors}
            progress={startup}
            error={startupError}
            logPath={startupLogPath}
            onRetry={boot}
            onOpenLog={handleOpenLogLocation}
          />
        ) : (
          <View style={styles.screen}>
            <View style={styles.header}>
              <Text style={[styles.title, {color: colors.text}]}>{activeTab}</Text>
              <View style={styles.headerActions}>
                {activeTab === '控制台' ? (
                  <Pressable
                    accessibilityLabel="容器状态"
                    disabled={containerBusy}
                    onPress={() => setRestartOpen(true)}
                    style={[styles.statusButton, {backgroundColor: colors.surface, borderColor: colors.border}]}>
                    {containerState === 'starting' ? (
                      <ActivityIndicator size="small" color={colors.accent} />
                    ) : (
                      <Text style={[styles.stateGlyph, {color: containerState === 'running' ? colors.success : colors.danger}]}>
                        {containerState === 'running' ? '✓' : '×'}
                      </Text>
                    )}
                    <Text style={[styles.statusText, {color: colors.text}]}>
                      {containerState === 'running' ? '运行中' : containerState === 'starting' ? '启动中' : '已停止'}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>

            <View style={styles.content}>
              {filesOpen && activeTab === '控制台' ? (
                <FileManagerScreen colors={colors} onBack={() => setFilesOpen(false)} />
              ) : activeTab === '控制台' ? (
                <DashboardScreen
                  colors={colors}
                  karinRunning={karinRunning}
                  karinSeconds={karinSeconds}
                  memoryBytes={karinMemoryBytes}
                  onOpenFiles={() => setFilesOpen(true)}
                  onAction={showNotice}
                />
              ) : activeTab === '设置' ? (
                <SettingsScreen
                  colors={colors}
                  version={karinVersion}
                  onOpen={() => setVersionOpen(true)}
                  onResetProject={() => setResetConfirm('project')}
                  onResetContainer={() => setResetConfirm('container')}
                />
              ) : (
                <PluginsScreen colors={colors} />
              )}
            </View>

            {notice ? <Toast message={notice} colors={colors} /> : null}

            {activeTab === '控制台' && !filesOpen ? (
              <Pressable
                accessibilityRole="switch"
                accessibilityState={{checked: karinRunning}}
                accessibilityLabel={karinRunning ? '停止 Karin' : '启动 Karin'}
                disabled={karinBusy}
                onPress={handleKarinToggle}
                style={styles.switchGroup}>
                <View style={[styles.karinSwitch, powerButtonStyle]}>
                  {karinBusy ? (
                    <ActivityIndicator size="small" color={karinRunning ? '#FFFFFF' : colors.muted} />
                  ) : (
                    <Power size={24} color={karinRunning ? '#FFFFFF' : colors.muted} strokeWidth={2.4} />
                  )}
                </View>
              </Pressable>
            ) : null}

            <BottomNav activeTab={activeTab} colors={colors} onSelect={tab => { setFilesOpen(false); setActiveTab(tab); }} />
          </View>
        )}

        {resetProgress ? (
          <View style={[styles.resetOverlay, {backgroundColor: colors.background}]}>
            <StartupScreen
              colors={colors}
              progress={resetProgress}
              error={resetError}
              logPath=""
              onRetry={() => setResetProgress(null)}
              onOpenLog={() => {}}
            />
          </View>
        ) : null}

        <RestartDialog
          visible={restartOpen}
          containerState={containerState}
          colors={colors}
          onClose={() => setRestartOpen(false)}
          onRestart={handleRestart}
        />
        <ConfirmDialog
          visible={resetConfirm !== null}
          title={resetConfirm === 'container' ? '重置容器' : '重置 Karin 项目'}
          body={
            resetConfirm === 'container'
              ? '将停止 Karin 与 proot 容器，删除整个 Debian 容器目录后重新解包安装，耗时较长且需要网络。'
              : '将停止 Karin，删除 /root/karin 目录（含配置与插件）后重新安装 node-karin 并执行初始化。'
          }
          confirmText={resetConfirm === 'container' ? '重置容器' : '重置项目'}
          colors={colors}
          onConfirm={handleReset}
          onClose={() => setResetConfirm(null)}
        />
        <VersionSheet
          visible={versionOpen}
          installedVersion={karinVersion}
          busy={versionBusy}
          colors={colors}
          onConfirm={handleVersionConfirm}
          onClose={() => setVersionOpen(false)}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: {flex: 1},
  screen: {flex: 1},
  content: {flex: 1},
  header: {paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  title: {fontSize: 26, fontWeight: '800'},
  headerActions: {flexDirection: 'row', alignItems: 'center', gap: 8},
  statusButton: {height: 38, paddingHorizontal: 11, borderRadius: 19, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 7},
  statusText: {fontSize: 12, fontWeight: '700'},
  stateGlyph: {fontSize: 19, fontWeight: '900'},
  switchGroup: {position: 'absolute', right: 20, bottom: 88, flexDirection: 'row', alignItems: 'center', gap: 9},
  resetOverlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
  karinSwitch: {
    width: 54,
    height: 54,
    borderRadius: 27,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 7,
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 7,
    shadowOffset: {width: 0, height: 4},
  },
});
