import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {Power} from 'lucide-react-native';
import BottomNav from './components/BottomNav';
import RestartDialog from './components/RestartDialog';
import StartupScreen from './components/StartupScreen';
import Toast from './components/Toast';
import VersionSheet from './components/VersionSheet';
import {useContainerStatus} from './hooks/useContainerStatus';
import {useKarinRuntime} from './hooks/useKarinRuntime';
import {useToast} from './hooks/useToast';
import DashboardScreen from './screens/DashboardScreen';
import PluginsScreen from './screens/PluginsScreen';
import SettingsScreen from './screens/SettingsScreen';
import {prootController} from './services/prootController';
import {inspectEnvironment, switchKarinVersion} from './services/environmentService';
import {openLogLocation, saveStartupLog} from './services/logService';
import {getStartupLog, runStartupTasks} from './startup/startupTasks';
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
    setRunning: setKarinRunning,
    seconds: karinSeconds,
    setSeconds: setKarinSeconds,
  } = useKarinRuntime();

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

  const handleKarinToggle = () => {
    const next = !karinRunning;
    setKarinRunning(next);
    if (next) {
      setKarinSeconds(0);
    }
    showNotice(next ? '正在启动 Karin（占位）' : '正在停止 Karin（占位）');
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
              {activeTab === '控制台' ? (
                <DashboardScreen
                  colors={colors}
                  karinRunning={karinRunning}
                  karinSeconds={karinSeconds}
                  onAction={showNotice}
                />
              ) : activeTab === '设置' ? (
                <SettingsScreen colors={colors} version={karinVersion} onOpen={() => setVersionOpen(true)} />
              ) : (
                <PluginsScreen colors={colors} />
              )}
            </View>

            {notice ? <Toast message={notice} colors={colors} /> : null}

            {activeTab === '控制台' ? (
              <Pressable
                accessibilityRole="switch"
                accessibilityState={{checked: karinRunning}}
                accessibilityLabel={karinRunning ? '停止 Karin' : '启动 Karin'}
                onPress={handleKarinToggle}
                style={styles.switchGroup}>
                <View style={[styles.karinSwitch, powerButtonStyle]}>
                  <Power size={24} color={karinRunning ? '#FFFFFF' : colors.muted} strokeWidth={2.4} />
                </View>
              </Pressable>
            ) : null}

            <BottomNav activeTab={activeTab} colors={colors} onSelect={setActiveTab} />
          </View>
        )}

        <RestartDialog
          visible={restartOpen}
          containerState={containerState}
          colors={colors}
          onClose={() => setRestartOpen(false)}
          onRestart={handleRestart}
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
