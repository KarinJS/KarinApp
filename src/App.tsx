import React, {useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  NativeModules,
} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {Check, ChevronRight, Circle, Cpu, FolderOpen, Home, MemoryStick, Power, Puzzle, Settings, Terminal as TerminalIcon} from 'lucide-react-native';
import {runStartupTasks, StartupProgress} from './startup/startupTasks';

type Tab = '控制台' | '插件' | '设置';
type ContainerState = 'starting' | 'running' | 'stopped';

const tabs: {label: Tab; icon: string}[] = [
  {label: '控制台', icon: 'home'},
  {label: '插件', icon: 'puzzle'},
  {label: '设置', icon: 'settings'},
];
const Proot = NativeModules.KarinProot as {start: () => Promise<string>; stop: (force?: boolean) => Promise<string>; status: () => Promise<string>};

function App() {
  const dark = useColorScheme() === 'dark';
  const colors = useMemo(() => (dark ? darkColors : lightColors), [dark]);
  const [startup, setStartup] = useState<StartupProgress>({stage: 'container', message: '正在准备 Karin', progress: 0, logs: []});
  const [startupDone, setStartupDone] = useState(false);
  const [startupError, setStartupError] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('控制台');
  const [containerState, setContainerState] = useState<ContainerState>('stopped');
  const [restartOpen, setRestartOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const noticeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [karinRunning, setKarinRunning] = useState(false);
  const [karinSeconds, setKarinSeconds] = useState(0);
  const [karinVersion, setKarinVersion] = useState('1.0.0');
  const [versionOpen, setVersionOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState('1.0.0');
  const [versionExpanded, setVersionExpanded] = useState(false);
  const [containerBusy, setContainerBusy] = useState(false);
  const versions = ['latest'];

  const boot = () => {
    setStartupError('');
    setStartupDone(false);
    runStartupTasks(setStartup)
      .then(async () => {setContainerState('running'); setStartupDone(true);})
      .catch(error => setStartupError(error instanceof Error ? error.message : '启动准备失败'));
  };

  useEffect(() => { boot(); }, []);

  useEffect(() => {
      const refresh = () => Proot.status().then(value => setContainerState(value as ContainerState)).catch(() => setContainerState('stopped'));
      refresh();
      const timer = setInterval(refresh, 1000);
      return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!karinRunning) {
      return;
    }
    const timer = setInterval(() => setKarinSeconds(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [karinRunning]);

  const showNotice = (message: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => {
      setNotice(current => current === message ? '' : current);
      noticeTimer.current = null;
    }, 2400);
  };

  const handleRestart = async (force: boolean) => {
    if (containerBusy) return;
    setContainerBusy(true);
    setRestartOpen(false);
    setContainerState('starting');
    try { await Proot.stop(force); await Proot.start(); setContainerState('running'); showNotice(force ? '容器已强制重启' : '容器已优雅重启'); }
    catch (error) { setContainerState('stopped'); showNotice(`容器启动失败: ${String(error)}`); }
    finally { setContainerBusy(false); }
  };

  return (
    <SafeAreaProvider>
    <SafeAreaView style={[styles.safe, {backgroundColor: colors.background}]} edges={['top', 'bottom']}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      {!startupDone ? <StartupScreen colors={colors} progress={startup} error={startupError} onRetry={boot} /> : null}
      {startupDone ? <View style={styles.screen}>
        <View style={styles.header}>
          <View>
            <Text style={[styles.title, {color: colors.text}]}>{activeTab}</Text>
          </View>
          <View style={styles.headerActions}>
            {activeTab === '控制台' && (
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
            )}
          </View>
        </View>

        <View style={styles.content}>
          {activeTab === '控制台' ? (
            <Dashboard colors={colors} karinRunning={karinRunning} karinSeconds={karinSeconds} karinVersion={karinVersion} onVersionPress={() => {setSelectedVersion(karinVersion); setVersionOpen(true);}} onAction={showNotice} />
          ) : activeTab === '设置' ? (
            <EnvironmentSettings colors={colors} version={karinVersion} onOpen={() => {setSelectedVersion(karinVersion); setVersionOpen(true);}} />
          ) : <Placeholder tab={activeTab} colors={colors} />}
        </View>

        {notice ? (
          <View style={[styles.toast, {backgroundColor: colors.toast}]}>
            <Text style={[styles.toastText, {color: colors.toastText}]}>{notice}</Text>
          </View>
        ) : null}

        {activeTab === '控制台' && (
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{checked: karinRunning}}
            accessibilityLabel={karinRunning ? '停止 Karin' : '启动 Karin'}
            onPress={() => {
              const next = !karinRunning;
              setKarinRunning(next);
              if (next) {
                setKarinSeconds(0);
              }
              showNotice(next ? '正在启动 Karin（占位）' : '正在停止 Karin（占位）');
            }}
            style={styles.switchGroup}>
            <View style={[styles.karinSwitch, {backgroundColor: karinRunning ? '#B9D9F7' : colors.surface, borderColor: karinRunning ? '#9FC7EE' : colors.border}]}>
              <Power size={24} color={karinRunning ? '#FFFFFF' : colors.muted} strokeWidth={2.4} />
            </View>
          </Pressable>
        )}

        <View style={[styles.nav, {backgroundColor: colors.surface, borderTopColor: colors.border}]}>
          {tabs.map(tab => (
            <Pressable key={tab.label} onPress={() => setActiveTab(tab.label)} style={styles.navItem}>
              <NavIcon name={tab.icon} color={activeTab === tab.label ? colors.accent : colors.muted} />
              <Text style={[styles.navLabel, {color: activeTab === tab.label ? colors.accent : colors.muted}]}>{tab.label}</Text>
            </Pressable>
          ))}
        </View>
      </View> : null}

      <Modal transparent visible={restartOpen} animationType="fade" onRequestClose={() => setRestartOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modal, {backgroundColor: colors.surface}]}>
            <Text style={[styles.modalTitle, {color: colors.text}]}>容器操作</Text>
            <Text style={[styles.modalBody, {color: colors.muted}]}>{containerState === 'stopped' ? 'proot 容器当前已停止，可以重新启动容器。' : '选择重启方式，应用会重新启动 proot 容器。'}</Text>
            <View style={styles.modalActions}>
              <Pressable onPress={() => setRestartOpen(false)} style={[styles.modalButton, {borderColor: colors.border}]}><Text style={[styles.modalButtonText, {color: colors.text}]}>取消</Text></Pressable>
              <Pressable onPress={() => handleRestart(false)} style={[styles.modalButton, {backgroundColor: colors.accent, borderColor: colors.accent}]}><Text style={styles.primaryText}>{containerState === 'stopped' ? '启动' : '重启'}</Text></Pressable>
              {containerState !== 'stopped' ? <Pressable onPress={() => handleRestart(true)} style={[styles.modalButton, {backgroundColor: colors.danger, borderColor: colors.danger}]}><Text style={styles.primaryText}>强制重启</Text></Pressable> : null}
            </View>
          </View>
        </View>
      </Modal>
      <Modal transparent visible={versionOpen} animationType="slide" onRequestClose={() => setVersionOpen(false)}>
        <View style={styles.sheetBackdrop}><Pressable style={styles.sheetDismiss} onPress={() => setVersionOpen(false)} /><View style={[styles.sheet, {backgroundColor: colors.surface}]}>
          <Text style={[styles.modalTitle, {color: colors.text}]}>选择 Karin 版本</Text>
          <Text style={[styles.modalBody, {color: colors.muted}]}>选择要使用的 Karin 版本</Text>
          <Pressable onPress={() => setVersionExpanded(value => !value)} style={[styles.versionSelect, {borderColor: colors.border}]}><Text style={[styles.versionText, {color: colors.text}]}>{selectedVersion}</Text><View style={styles.selectArrowBox}><View style={[styles.selectArrow, {borderColor: colors.muted}, versionExpanded && styles.selectArrowUp]} /></View></Pressable>
          {versionExpanded && <View style={[styles.versionPicker, {borderColor: colors.border}]}><ScrollView style={styles.versionList} nestedScrollEnabled>{versions.map(version => <Pressable key={version} onPress={() => {setSelectedVersion(version); setVersionExpanded(false);}} style={[styles.versionOption, selectedVersion === version && {backgroundColor: colors.accentSoft}]}><Text style={[styles.versionText, {color: selectedVersion === version ? colors.accent : colors.text}]}>{version}</Text></Pressable>)}</ScrollView></View>}
          <View style={styles.modalActions}><Pressable onPress={() => setVersionOpen(false)} style={[styles.modalButton, {borderColor: colors.border}]}><Text style={[styles.modalButtonText, {color: colors.text}]}>取消</Text></Pressable><Pressable onPress={() => {setKarinVersion(selectedVersion); setVersionOpen(false); showNotice('版本已更新（占位）');}} style={[styles.modalButton, {backgroundColor: colors.accent, borderColor: colors.accent}]}><Text style={styles.primaryText}>确认</Text></Pressable></View>
        </View></View>
      </Modal>
    </SafeAreaView>
    </SafeAreaProvider>
  );
}

function StartupScreen({colors, progress, error, onRetry}: {colors: Colors; progress: StartupProgress; error: string; onRetry: () => void}) {
  const percent = Math.round(progress.progress * 100);
  const steps: {stage: StartupProgress['stage']; label: string; detail: string}[] = [
    {stage: 'container', label: '初始化 proot 容器', detail: '首次启动时准备 Debian 文件系统'},
    {stage: 'proot', label: '启动 proot 容器', detail: '建立移动端运行环境'},
    {stage: 'environment', label: '检查运行环境', detail: '准备 Node.js、npm、pnpm 与 Karin'},
  ];
  const activeIndex = steps.findIndex(item => item.stage === progress.stage);
  const logs = progress.logs.slice(-4);
  return <View style={[styles.startup, {backgroundColor: colors.background}]}>
    <View style={[styles.startupMark, {backgroundColor: colors.accentSoft, borderColor: colors.border}]}><Text style={[styles.startupMarkText, {color: colors.accent}]}>K</Text><View style={[styles.startupSpinner, {backgroundColor: colors.background}]}><ActivityIndicator size="small" color={colors.accent} /></View></View>
    <Text style={[styles.startupTitle, {color: colors.text}]}>Karin</Text>
    <Text style={[styles.startupSubtitle, {color: colors.muted}]}>Android 运行环境</Text>
    <View style={styles.startupSteps}>{steps.map((item, index) => {
      const complete = index < activeIndex || progress.progress === 1;
      const active = index === activeIndex && !error && !complete;
      return <View key={item.stage} style={styles.startupStep}>
        <View style={[styles.stepIcon, {backgroundColor: complete ? colors.successSoft : active ? colors.accentSoft : colors.neutralSoft}]}>{complete ? <Check size={15} strokeWidth={3} color={colors.success} /> : active ? <ActivityIndicator size="small" color={colors.accent} /> : <Circle size={12} color={colors.muted} />}</View>
        <View style={styles.stepCopy}><Text style={[styles.stepLabel, {color: complete || active ? colors.text : colors.muted}]}>{item.label}</Text><Text style={[styles.stepDetail, {color: colors.muted}]}>{active ? progress.message : item.detail}</Text></View>
      </View>;
    })}</View>
    <View style={[styles.progressTrack, {backgroundColor: colors.border}]}><View style={[styles.progressFill, {backgroundColor: colors.accent, width: `${Math.max(4, percent)}%`}]} /></View>
    <View style={styles.startupStatus}><Text style={[styles.startupMessage, {color: colors.text}]}>{error || progress.message}</Text><Text style={[styles.startupPercent, {color: colors.accent}]}>{error ? '!' : `${percent}%`}</Text></View>
    {logs.length > 0 ? <View style={[styles.startupLog, {backgroundColor: colors.neutralSoft, borderColor: colors.border}]}>
      <Text style={[styles.startupLogTitle, {color: colors.muted}]}>安装日志</Text>
      {logs.map((line, index) => <Text key={`${index}-${line}`} numberOfLines={1} style={[styles.startupLogLine, {color: colors.text}]}>{line}</Text>)}
    </View> : !error ? <Text style={[styles.startupHint, {color: colors.muted}]}>首次启动可能需要准备容器文件</Text> : null}
    {error ? <Pressable onPress={onRetry} style={[styles.retryButton, {backgroundColor: colors.accent}]}><Text style={styles.primaryText}>重试</Text></Pressable> : null}
  </View>;
}

function Dashboard({colors, karinRunning, karinSeconds, karinVersion, onVersionPress, onAction}: {colors: Colors; karinRunning: boolean; karinSeconds: number; karinVersion: string; onVersionPress: () => void; onAction: (message: string) => void}) {
  return (
    <ScrollView contentContainerStyle={styles.dashboard}>
      <View style={[styles.statusRow, {backgroundColor: colors.surface, borderColor: colors.border}]}><View style={[styles.statusDotLarge, {backgroundColor: karinRunning ? colors.success : colors.muted}]} /><View style={styles.statusRowContent}><Text style={[styles.infoLabel, {color: colors.muted}]}>Karin 服务</Text><Text style={[styles.statusRowValue, {color: karinRunning ? colors.text : colors.muted}]}>{karinRunning ? runtimeLabel(karinSeconds) : '未运行'}</Text></View><Text style={[styles.statusRowHint, {color: colors.muted}]}>右下角开关控制</Text></View>
      <View style={styles.infoGrid}>
        <InfoCard title="内存占用" value={karinRunning ? '128 MB' : '--'} description="当前 Karin 使用量" color={colors.purple} softColor={colors.purpleSoft} icon="memory" colors={colors} />
        <InfoCard title="系统架构" value="arm64" description="Android 运行环境" color={colors.orange} softColor={colors.orangeSoft} icon="cpu" colors={colors} />
      </View>
      <Pressable onPress={onVersionPress} style={[styles.versionRow, {borderBottomColor: colors.border}]}><Text style={[styles.infoLabel, {color: colors.muted}]}>Karin 运行版本</Text><View style={styles.versionRowRight}><Text style={[styles.versionRowValue, {color: colors.text}]}>{karinVersion}</Text><ChevronRight size={17} color={colors.muted} /></View></Pressable>
      <Text style={[styles.sectionTitle, {color: colors.text}]}>快捷操作</Text>
      <View style={styles.actions}>
        <Action title="终端" subtitle="运行 Karin 命令" icon="terminal" colors={colors} onPress={() => onAction('终端功能占位')} />
        <Action title="文件管理" subtitle="浏览容器文件" icon="folder" colors={colors} onPress={() => onAction('文件管理功能占位')} />
      </View>
    </ScrollView>
  );
}

function runtimeLabel(totalSeconds: number) { const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, '0'); const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0'); const seconds = (totalSeconds % 60).toString().padStart(2, '0'); return `${hours}:${minutes}:${seconds}`; }

function NavIcon({name, color}: {name: string; color: string}) {
  if (name === 'home') return <Home size={21} color={color} />;
  if (name === 'puzzle') return <Puzzle size={21} color={color} />;
  return <Settings size={21} color={color} />;
}

function Placeholder({tab, colors}: {tab: Tab; colors: Colors}) {
  const icon = tabs.find(item => item.label === tab)?.icon;
  return <View style={styles.placeholder}><Text style={[styles.placeholderIcon, {color: colors.accent}]}>{icon}</Text><Text style={[styles.placeholderTitle, {color: colors.text}]}>{tab}</Text><Text style={[styles.placeholderCopy, {color: colors.muted}]}>功能模块占位，后续接入真实能力</Text></View>;
}

function EnvironmentSettings({colors, version, onOpen}: {colors: Colors; version: string; onOpen: () => void}) {
  return <ScrollView contentContainerStyle={styles.settingsContent}>
    <Text style={[styles.settingsIntro, {color: colors.muted}]}>统一管理容器运行环境与 Karin 版本</Text>
    <View style={[styles.environmentList, {backgroundColor: colors.surface, borderColor: colors.border}]}>
      <Pressable onPress={onOpen} style={styles.environmentRow}><View style={styles.environmentCopy}><Text style={[styles.environmentLabel,{color: colors.text}]}>Karin 版本</Text><Text style={[styles.environmentValue,{color: colors.muted}]}>{version}</Text></View><ChevronRight size={18} color={colors.muted}/></Pressable>
    </View>
  </ScrollView>;
}

function InfoCard({title, value, description, color, softColor, icon, colors}: {title: string; value: string; description: string; color: string; softColor: string; icon: string; colors: Colors}) {
  return <View style={[styles.infoCard, {backgroundColor: colors.surface, borderColor: colors.border}]}><View style={[styles.infoIcon, {backgroundColor: softColor}]}><InfoIcon name={icon} color={color} /></View><Text style={[styles.infoLabel, {color: colors.muted}]}>{title}</Text><Text style={[styles.infoValue, {color: colors.text}]}>{value}</Text><Text style={[styles.infoDescription, {color: colors.muted}]}>{description}</Text></View>;
}

function InfoIcon({name, color}: {name: string; color: string}) { return name === 'cpu' ? <Cpu size={15} color={color} /> : <MemoryStick size={15} color={color} />; }

function Action({title, subtitle, icon, colors, onPress}: {title: string; subtitle: string; icon: string; colors: Colors; onPress: () => void}) {
  const glyph = icon === 'terminal' ? <TerminalIcon size={22} color={colors.accent} /> : <FolderOpen size={22} color={colors.accent} />;
  return <Pressable onPress={onPress} style={[styles.action, {backgroundColor: colors.surface, borderColor: colors.border}]}><View style={styles.actionIcon}>{glyph}</View><View><Text style={[styles.actionTitle, {color: colors.text}]}>{title}</Text><Text style={[styles.actionSubtitle, {color: colors.muted}]}>{subtitle}</Text></View></Pressable>;
}

const lightColors = {background: '#F5F7FA', surface: '#FFFFFF', text: '#17202A', muted: '#718096', border: '#E2E8F0', accent: '#2563EB', accentSoft: '#E8F0FF', success: '#16A34A', successSoft: '#E7F7EC', neutralSoft: '#EEF1F5', purple: '#7C3AED', purpleSoft: '#F0EAFE', orange: '#D97706', orangeSoft: '#FFF3DE', danger: '#DC2626', toast: '#17202A', toastText: '#FFFFFF'};
const darkColors = {background: '#10151C', surface: '#18212C', text: '#F3F6FA', muted: '#9AA9BA', border: '#2A3948', accent: '#65A4FF', accentSoft: '#1C3555', success: '#4ADE80', successSoft: '#183D2A', neutralSoft: '#26323F', purple: '#B794F6', purpleSoft: '#35284D', orange: '#FBBF74', orangeSoft: '#45331F', danger: '#F87171', toast: '#E7EDF5', toastText: '#17202A'};
type Colors = typeof lightColors;

const styles = StyleSheet.create({
  safe: {flex: 1}, screen: {flex: 1}, content: {flex: 1},
  startup: {flex: 1, paddingHorizontal: 28, alignItems: 'center', justifyContent: 'center'},
  startupMark: {width: 76, height: 76, borderRadius: 24, borderWidth: 1, alignItems: 'center', justifyContent: 'center'},
  startupSpinner: {position: 'absolute', right: -7, bottom: -7, width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center'},
  startupMarkText: {fontSize: 38, fontWeight: '900', letterSpacing: -2},
  startupTitle: {fontSize: 28, fontWeight: '900', marginTop: 18, letterSpacing: 0.4},
  startupSubtitle: {fontSize: 12, fontWeight: '600', marginTop: 5},
  progressTrack: {width: '100%', height: 5, borderRadius: 3, overflow: 'hidden', marginTop: 28},
  progressFill: {height: '100%', borderRadius: 3},
  startupStatus: {width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 13},
  startupMessage: {fontSize: 13, fontWeight: '700'}, startupPercent: {fontSize: 12, fontWeight: '800'},
  startupHint: {fontSize: 11, marginTop: 11, alignSelf: 'flex-start'},
  startupLog: {width: '100%', marginTop: 11, borderRadius: 9, borderWidth: 1, padding: 10, gap: 3},
  startupLogTitle: {fontSize: 9, fontWeight: '700', marginBottom: 2, opacity: 0.85},
  startupLogLine: {fontSize: 10, lineHeight: 14, fontVariant: ['tabular-nums']},
  startupSteps: {width: '100%', marginTop: 34, gap: 15}, startupStep: {flexDirection: 'row', alignItems: 'center', gap: 11},
  stepIcon: {width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center'}, stepCopy: {flex: 1}, stepLabel: {fontSize: 13, fontWeight: '800'}, stepDetail: {fontSize: 10, marginTop: 2},
  retryButton: {minWidth: 92, minHeight: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 20},
  header: {paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  title: {fontSize: 26, fontWeight: '800'},
  headerActions: {flexDirection: 'row', alignItems: 'center', gap: 8},
  statusButton: {height: 38, paddingHorizontal: 11, borderRadius: 19, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 7},
  statusText: {fontSize: 12, fontWeight: '700'}, stateGlyph: {fontSize: 19, fontWeight: '900'}, iconButton: {width: 38, height: 38, borderRadius: 19, borderWidth: 1, alignItems: 'center', justifyContent: 'center'}, icon: {fontSize: 18},
  dashboard: {padding: 16, paddingTop: 4, paddingBottom: 104}, statusRow: {borderRadius: 12, borderWidth: 1, padding: 13, flexDirection: 'row', alignItems: 'center'}, statusDotLarge: {width: 10, height: 10, borderRadius: 5, marginRight: 11}, statusRowContent: {flex: 1}, statusRowValue: {fontSize: 17, fontWeight: '800', marginTop: 3}, statusRowHint: {fontSize: 10}, infoGrid: {flexDirection: 'row', gap: 8, marginTop: 8}, infoCard: {flex: 1, minHeight: 102, borderRadius: 12, borderWidth: 1, padding: 11}, infoIcon: {width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginBottom: 8}, infoIconText: {fontSize: 12, fontWeight: '900'}, infoLabel: {fontSize: 10, fontWeight: '600'}, infoValue: {fontSize: 17, fontWeight: '800', marginTop: 4}, infoDescription: {fontSize: 9, lineHeight: 12, marginTop: 3}, versionRow: {minHeight: 48, borderBottomWidth: 1, marginTop: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}, versionRowRight: {flexDirection: 'row', alignItems: 'center'}, versionRowValue: {fontSize: 14, fontWeight: '700'}, rowArrow: {fontSize: 21, marginLeft: 8},
  sectionTitle: {fontSize: 17, fontWeight: '800', marginTop: 25, marginBottom: 11}, actions: {gap: 10}, action: {borderRadius: 12, borderWidth: 1, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14}, actionIcon: {fontSize: 24, fontWeight: '800', width: 32, textAlign: 'center'}, actionTitle: {fontSize: 15, fontWeight: '700'}, actionSubtitle: {fontSize: 12, marginTop: 4},
  nav: {height: 72, borderTopWidth: 1, flexDirection: 'row', paddingBottom: 4}, navItem: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4}, navIcon: {fontSize: 21, fontWeight: '700'}, navLabel: {fontSize: 11, fontWeight: '700'},
  placeholder: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30}, placeholderIcon: {fontSize: 44}, placeholderTitle: {fontSize: 24, fontWeight: '800', marginTop: 15}, placeholderCopy: {fontSize: 13, marginTop: 7},
  settingsContent: {paddingHorizontal: 16, paddingTop: 4, paddingBottom: 28}, settingsIntro: {fontSize: 12, lineHeight: 18, marginBottom: 12},
  environmentList: {borderWidth: 1, borderRadius: 13, overflow: 'hidden'}, environmentItem: {borderBottomWidth: StyleSheet.hairlineWidth},
  environmentRow: {minHeight: 62, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}, environmentCopy: {gap: 4}, environmentLabel: {fontSize: 14, fontWeight: '700'}, environmentValue: {fontSize: 11, fontWeight: '600'},
  environmentPicker: {marginHorizontal: 10, marginBottom: 10, borderWidth: 1, borderRadius: 9, overflow: 'hidden'}, environmentOption: {height: 42, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}, environmentOptionText: {fontSize: 13, fontWeight: '700'},
  toast: {position: 'absolute', left: 20, right: 20, bottom: 152, padding: 13, borderRadius: 10, alignItems: 'center', zIndex: 20, elevation: 20}, toastText: {fontSize: 13, fontWeight: '600'},
  switchGroup: {position: 'absolute', right: 20, bottom: 88, flexDirection: 'row', alignItems: 'center', gap: 9}, karinSwitch: {width: 54, height: 54, borderRadius: 27, borderWidth: 1, alignItems: 'center', justifyContent: 'center', elevation: 7, shadowColor: '#000000', shadowOpacity: 0.18, shadowRadius: 7, shadowOffset: {width: 0, height: 4}}, powerGlyph: {fontSize: 25, fontWeight: '800'}, switchRuntime: {fontSize: 12, fontWeight: '800'}, versionSelect: {height: 48, borderWidth: 1, borderRadius: 10, marginTop: 16, paddingLeft: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}, selectArrowBox: {width: 46, height: 46, alignItems: 'center', justifyContent: 'center'}, selectArrow: {width: 8, height: 8, borderRightWidth: 2, borderBottomWidth: 2, transform: [{rotate: '45deg'}], marginTop: -4}, selectArrowUp: {transform: [{rotate: '225deg'}], marginTop: 4}, versionPicker: {height: 148, borderWidth: 1, borderRadius: 10, marginTop: 7, overflow: 'hidden'}, versionList: {flex: 1}, versionOption: {height: 44, justifyContent: 'center', paddingHorizontal: 14}, versionText: {fontSize: 15, fontWeight: '700'},
  modalBackdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.46)', alignItems: 'center', justifyContent: 'center', padding: 24}, modal: {width: '100%', borderRadius: 16, padding: 20}, sheetBackdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.42)', justifyContent: 'flex-end'}, sheetDismiss: {flex: 1}, sheet: {borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 28}, modalTitle: {fontSize: 20, fontWeight: '800'}, modalBody: {fontSize: 13, lineHeight: 19, marginTop: 8}, modalActions: {flexDirection: 'row', gap: 8, marginTop: 22}, modalButton: {flex: 1, minHeight: 42, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5}, modalButtonText: {fontSize: 12, fontWeight: '700'}, primaryText: {color: '#FFFFFF', fontSize: 12, fontWeight: '800'},
});

export default App;
