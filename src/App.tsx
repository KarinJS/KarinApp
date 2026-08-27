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
import {runStartupTasks} from './startup/startupTasks';
import type {StartupProgress} from './startup/startupTasks';
import {useAppColors} from './theme/colors';
import type {Tab} from './types';

const INITIAL_STARTUP: StartupProgress = {
  stage: 'container',
  message: '正在准备 Karin',
  progress: 0,
  logs: [],
};

const VERSIONS = ['latest'];

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
  const [activeTab, setActiveTab] = useState<Tab>('控制台');
  const [restartOpen, setRestartOpen] = useState(false);
  const [karinVersion, setKarinVersion] = useState('1.0.0');
  const [versionOpen, setVersionOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState('1.0.0');
  const [containerBusy, setContainerBusy] = useState(false);

  const boot = () => {
    setStartupError('');
    setStartupDone(false);
    runStartupTasks(setStartup)
      .then(async () => {
        setContainerState('running');
        setStartupDone(true);
      })
      .catch(error => setStartupError(error instanceof Error ? error.message : '启动准备失败'));
  };

  // ֻ�ڹ���ʱ����һ�Σ�boot �ڲ������Զ��� hook �� setter�������޷��ж����ȶ���
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

  const openVersionSheet = () => {
    setSelectedVersion(karinVersion);
    setVersionOpen(true);
  };

  const handleVersionConfirm = () => {
    setKarinVersion(selectedVersion);
    setVersionOpen(false);
    showNotice('版本已更新（占位）');
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
          <StartupScreen colors={colors} progress={startup} error={startupError} onRetry={boot} />
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
                  karinVersion={karinVersion}
                  onVersionPress={openVersionSheet}
                  onAction={showNotice}
                />
              ) : activeTab === '设置' ? (
                <SettingsScreen colors={colors} version={karinVersion} onOpen={openVersionSheet} />
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
          versions={VERSIONS}
          selectedVersion={selectedVersion}
          colors={colors}
          onSelect={setSelectedVersion}
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
