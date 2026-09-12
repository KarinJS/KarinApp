import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Keyboard,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  BadgeCheck,
  ChevronDown,
  ChevronUp,
  CircleCheckBig,
  CircleDashed,
  Download,
  FileCode,
  FileUp,
  Gamepad2,
  GitBranch,
  Layers,
  Link2,
  Package,
  Plug,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Tag,
  Trash2,
  Wrench,
  X,
  XCircle,
} from 'lucide-react-native';
import DraggableFab from '../components/DraggableFab';
import {GithubIcon, NpmIcon} from '../components/BrandIcons';
import LogConsole from '../components/LogConsole';
import MarkdownView from '../components/MarkdownView';
import {Colors} from '../theme/colors';
import {loadAppSettings} from '../services/appSettings';
import {canImportLocalAppPlugin, importLocalAppPlugin} from '../services/appPluginImport';
import {
  APP_PLUGIN_DIR,
  APP_PLUGIN_ROOTFS_DIR,
  appPluginDirEntry,
  appPluginFileName,
  appPluginFiles,
  appPluginNameFromUrl,
  fetchPluginDetails,
  githubUrlFrom,
  gitPluginNameFromUrl,
  installPlugin,
  loadPluginSnapshot,
  manualAppPlugin,
  manualGitPlugin,
  npmPackageUrl,
  Plugin,
  PluginDetails,
  PluginFile,
  PluginSnapshot,
  PluginType,
  pluginCategoryIds,
  pluginInstallPath,
  removePlugin,
} from '../services/pluginService';

type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';
type TaskKind = 'install' | 'remove';
type TaskOptions = {
  files?: PluginFile[];
  renames?: Record<string, string>;
  appFiles?: string[];
  /** 未知来源文件（手动导入 / 直链下载）：不写归属记账 */
  thirdParty?: boolean;
};

type PluginDetailState =
  | {status: 'loading'; npmUrl: string}
  | {status: 'ready'; details: PluginDetails}
  | {status: 'error'; npmUrl: string}
  | {status: 'files'}
  /** 本地探测到的 git 插件：npm 上没有条目，没有 README 可看 */
  | {status: 'local'};

type PluginTask = {
  name: string;
  kind: TaskKind;
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  logs: string[];
};

/** 文件选择弹窗：安装（挑要装的文件）/ 卸载（挑要删的 APP 插件文件） */
type PickerState = {mode: 'install' | 'remove'; plugin: Plugin};

/** 同名文件冲突：让用户选择替换还是重命名 */
type ConflictState = {plugin: Plugin; files: PluginFile[]; conflicts: string[]};

type IconComponent = React.ComponentType<{size?: number; color?: string}>;

/** 固定的三个筛选：全部 / 已安装 / 未安装 */
const BASE_FILTERS: {id: string; label: string; Icon: IconComponent}[] = [
  {id: 'all', label: '全部', Icon: Layers},
  {id: 'installed', label: '已安装', Icon: CircleCheckBig},
  {id: 'uninstalled', label: '未安装', Icon: CircleDashed},
];

/**
 * 预留分类：市场数据里出现对应标签时才会显示该筛选项。
 * 之后插件列表新增分类，只要市场字段带上标签（category/categories/tags）就会自动出现在这里。
 */
const CATEGORY_META: Record<string, {label: string; Icon: IconComponent}> = {
  official: {label: '官方插件', Icon: BadgeCheck},
  tool: {label: '工具', Icon: Wrench},
  adapter: {label: '适配器', Icon: Plug},
  fun: {label: '娱乐', Icon: Gamepad2},
};
const CATEGORY_ORDER = ['official', 'tool', 'adapter', 'fun'];

const TYPE_META: Record<PluginType, {label: string; Icon: IconComponent; color: keyof Colors}> = {
  npm: {label: 'npm', Icon: Package, color: 'danger'},
  git: {label: 'git', Icon: GitBranch, color: 'purple'},
  app: {label: 'js', Icon: FileCode, color: 'orange'},
};

const statusStyle = (status: TaskStatus, colors: Colors) => {
  if (status === 'running') return {label: '运行中', background: colors.accentSoft, color: colors.accent};
  if (status === 'completed') return {label: '已完成', background: colors.successSoft, color: colors.success};
  if (status === 'cancelled') return {label: '已终止', background: colors.neutralSoft, color: colors.muted};
  return {label: '失败', background: colors.neutralSoft, color: colors.danger};
};

const formatDuration = (milliseconds: number) => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
};

/** 同名文件冲突时换一个不占用的文件名 */
const freeFileName = (name: string, taken: Set<string>) => {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let index = 1;
  let candidate = `${base}-${index}${extension}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${base}-${index}${extension}`;
  }
  return candidate;
};

/** 任务日志里的文件大小；app 插件一般只有几十 KB */
const formatFileSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未知';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

/** 已安装文件名对应的市场文件信息（改过名就匹配不到） */
const marketFileLabel = (plugin: Plugin, name: string) => {
  const matched = appPluginFiles(plugin).find(file => {
    try {
      return appPluginFileName(file.url) === name;
    } catch {
      return false;
    }
  });
  return matched ? [matched.name, matched.description].filter(Boolean).join(' · ') : '';
};

/** 搜索匹配：插件名或市场里的介绍包含关键字（已在外面转成小写） */
const matchesQuery = (plugin: Plugin, query: string) =>
  plugin.name.toLowerCase().includes(query) || (plugin.description ?? '').toLowerCase().includes(query);

function FilterChip({
  active,
  colors,
  count,
  Icon,
  label,
  onPress,
}: {
  active: boolean;
  colors: Colors;
  count: number;
  Icon: IconComponent;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole='button'
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: active ? colors.accentSoft : colors.surface,
          borderColor: active ? colors.accent : colors.border,
        },
      ]}>
      <Icon color={active ? colors.accent : colors.muted} size={13} />
      <Text style={[styles.chipText, {color: active ? colors.accent : colors.muted}]}>{label}</Text>
      <Text style={[styles.chipCount, {color: active ? colors.accent : colors.muted}]}>{count}</Text>
    </Pressable>
  );
}

function TaskCard({
  colors,
  expanded,
  onToggle,
  onStop,
  task,
}: {
  colors: Colors;
  expanded: boolean;
  onToggle: () => void;
  onStop: () => void;
  task: PluginTask;
}) {
  const running = task.status === 'running';
  const status = statusStyle(task.status, colors);
  const [now, setNow] = useState(task.startedAt);

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const elapsed = (task.endedAt ?? now) - task.startedAt;

  return (
    <View style={[styles.taskCard, {backgroundColor: colors.neutralSoft, borderColor: colors.border}]}>
      <View style={styles.taskCardHeader}>
        <Pressable accessibilityRole='button' onPress={onToggle} style={styles.taskToggleButton}>
          {task.kind === 'remove' ? (
            <Trash2 size={15} color={colors.danger} />
          ) : (
            <Download size={15} color={colors.accent} />
          )}
          <View style={styles.taskInfo}>
            <Text numberOfLines={1} style={[styles.taskName, {color: colors.text}]}>
              {task.name}
            </Text>
            <View style={styles.taskMeta}>
              <View style={[styles.statusPill, {backgroundColor: status.background}]}>
                {running ? <ActivityIndicator color={status.color} size='small' /> : null}
                <Text style={[styles.statusText, {color: status.color}]}>{status.label}</Text>
              </View>
              <Text style={[styles.duration, {color: colors.muted}]}>用时 {formatDuration(elapsed)}</Text>
            </View>
          </View>
          <ChevronDown
            color={colors.muted}
            size={16}
            style={expanded ? styles.chevronExpanded : styles.chevron}
          />
        </Pressable>
        {running ? (
          <Pressable
            accessibilityRole='button'
            onPress={onStop}
            style={[styles.stopButton, {backgroundColor: colors.danger}]}>
            <XCircle color='#fff' size={14} />
            <Text style={styles.stopButtonText}>终止</Text>
          </Pressable>
        ) : null}
      </View>
      {expanded ? (
        <LogConsole colors={colors} logs={task.logs} />
      ) : null}
    </View>
  );
}

export default function PluginsScreen({colors, onOpenDeps}: {colors: Colors; onOpenDeps: () => void}) {
  const insets = useSafeAreaInsets();
  const [snapshot, setSnapshot] = useState<PluginSnapshot>({plugins: [], appDirFiles: []});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tasks, setTasks] = useState<Record<string, PluginTask>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [tasksOpen, setTasksOpen] = useState(false);
  const [detailPlugin, setDetailPlugin] = useState<Plugin | null>(null);
  const [detailState, setDetailState] = useState<PluginDetailState>({status: 'loading', npmUrl: ''});
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  /** 安装方式选择：本地文件 / 直链下载 */
  const [installChoiceOpen, setInstallChoiceOpen] = useState(false);
  /** 市场里没有的 app 插件文件：用户自己填直链和文件名 */
  const [manualOpen, setManualOpen] = useState(false);
  const [manualUrl, setManualUrl] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualError, setManualError] = useState('');
  /** 市场里没有的 git 插件：用户自己填仓库地址、分支和目录名 */
  const [gitOpen, setGitOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState('');
  const [gitName, setGitName] = useState('');
  const [gitBranch, setGitBranch] = useState('');
  const [gitError, setGitError] = useState('');
  /** 居中的表单（直链安装 / git 安装）被输入法顶上来时需要的底部内边距，0 表示键盘没弹 */
  const [manualKeyboardInset, setManualKeyboardInset] = useState(0);
  const [selectedFiles, setSelectedFiles] = useState<Record<string, boolean>>({});
  const taskCancellers = useRef<Record<string, AbortController>>({});
  const detailRequestId = useRef(0);
  const loadedOnce = useRef(false);
  const sheetY = useRef(new Animated.Value(330)).current;
  const manualStep = useRef<React.ComponentRef<typeof View>>(null);
  const gitStep = useRef<React.ComponentRef<typeof View>>(null);

  const load = useCallback(async (force = false) => {
    if (loadedOnce.current) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      /** 安装命令要同步拼 GitHub 加速前缀，先确保设置已加载 */
      await loadAppSettings();
      setSnapshot(await loadPluginSnapshot(force));
      loadedOnce.current = true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (tasksOpen) {
      sheetY.setValue(330);
      Animated.spring(sheetY, {toValue: 0, useNativeDriver: true}).start();
    }
  }, [sheetY, tasksOpen]);

  // Android 15 起 targetSdk 35+ 强制 edge-to-edge，Modal 里的 adjustResize 同样不再缩小窗口，
  // 输入法会盖住居中的表单（直链安装 / git 安装）。这里按表单容器在窗口里的真实底边算要抬多高：
  // 窗口已经被系统缩过的设备（非 edge-to-edge）算出来是 0，不会重复抬；+ insets.bottom 是因为
  // 原生上报的键盘高度扣掉了导航栏，而 edge-to-edge 下内容本来就画到导航栏底下。
  useEffect(() => {
    const target = manualOpen ? manualStep : gitOpen ? gitStep : null;
    if (!target) {
      setManualKeyboardInset(0);
      return;
    }
    const show = Keyboard.addListener('keyboardDidShow', event => {
      const keyboardHeight = event.endCoordinates.height + insets.bottom;
      target.current?.measureInWindow((_x, y, _width, height) => {
        const bottomGap = Dimensions.get('screen').height - (y + height);
        setManualKeyboardInset(Math.max(0, Math.round(keyboardHeight - bottomGap)));
      });
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setManualKeyboardInset(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [gitOpen, insets.bottom, manualOpen]);

  const appDirFiles = snapshot.appDirFiles;
  const dirNames = useMemo(() => new Set(appDirFiles.map(file => file.name)), [appDirFiles]);
  const dirOwners = useMemo(() => new Map(appDirFiles.map(file => [file.name, file.owner])), [appDirFiles]);
  /** 手动安装弹窗里实时预览的落地文件名，以及会不会覆盖已有文件 */
  const manualTarget = useMemo(() => {
    const wanted = (manualName.trim() || appPluginNameFromUrl(manualUrl)).trim();
    if (!wanted) return '';
    return wanted.toLowerCase().endsWith('.js') ? wanted : `${wanted}.js`;
  }, [manualName, manualUrl]);
  const manualConflict = manualTarget !== '' && dirNames.has(manualTarget);
  /** git 安装表单里实时预览的目标目录名，以及会不会覆盖已装的插件目录 */
  const gitTarget = useMemo(() => (gitName.trim() || gitPluginNameFromUrl(gitUrl)).trim(), [gitName, gitUrl]);
  const gitNameValid = gitTarget === '' || /^(?:@[\w.-]+\/)?[\w.-]+$/.test(gitTarget);
  const installedNames = useMemo(
    () => new Set(snapshot.plugins.filter(plugin => plugin.installed).map(plugin => plugin.name)),
    [snapshot.plugins],
  );
  const gitConflict = gitTarget !== '' && installedNames.has(gitTarget);
  /** 旧版本原生层没有导入模块时，本地文件那条路给个明确提示而不是点了没反应 */
  const localImportAvailable = useMemo(() => canImportLocalAppPlugin(), []);
  /** karin-plugin-example 是固定条目，永远排在最前面 */
  const dirEntry = useMemo(() => appPluginDirEntry(snapshot), [snapshot]);
  const rows = useMemo(() => [dirEntry, ...snapshot.plugins], [dirEntry, snapshot.plugins]);
  /** 卸载时可勾选的文件：目录条目是目录下全部文件，市场条目是哈希匹配到的已装文件 */
  const removeTargets = useCallback(
    (plugin: Plugin) => (plugin.virtual ? appDirFiles.map(file => file.name) : plugin.installedFiles ?? []),
    [appDirFiles],
  );

  const counts = useMemo(() => {
    const counter: Record<string, number> = {all: rows.length, installed: 0, uninstalled: 0};
    rows.forEach(plugin => {
      counter[plugin.installed ? 'installed' : 'uninstalled'] += 1;
      pluginCategoryIds(plugin).forEach(id => {
        counter[id] = (counter[id] ?? 0) + 1;
      });
    });
    return counter;
  }, [rows]);

  /** 只展示有插件的分类，顺序按预留分类固定，未收录的新分类排在后面 */
  const filters = useMemo(() => {
    const ids = Object.keys(counts).filter(id => counts[id] > 0 && !BASE_FILTERS.some(item => item.id === id));
    const ordered = [
      ...CATEGORY_ORDER.filter(id => ids.includes(id)),
      ...ids.filter(id => !CATEGORY_ORDER.includes(id)).sort(),
    ];
    return [...BASE_FILTERS, ...ordered.map(id => ({id, ...(CATEGORY_META[id] ?? {label: id, Icon: Tag})}))];
  }, [counts]);

  const categoryFilters = useMemo(
    () => filters.filter(item => !BASE_FILTERS.some(base => base.id === item.id)),
    [filters],
  );

  /** 当前选中的分类：收起时只在这里显示，避免分类多了要滑很久 */
  const activeCategory = useMemo(
    () => filters.find(item => item.id === filter && !BASE_FILTERS.some(base => base.id === item.id)) ?? null,
    [filter, filters],
  );

  /** 搜索关键字：在当前筛选结果里再筛一层，插件名和介绍都算命中 */
  const search = query.trim().toLowerCase();

  const visibleRows = useMemo(() => {
    const matched = rows.filter(plugin => {
      if (search && !matchesQuery(plugin, search)) return false;
      if (filter === 'all') return true;
      if (filter === 'installed') return Boolean(plugin.installed);
      if (filter === 'uninstalled') return !plugin.installed;
      return pluginCategoryIds(plugin).includes(filter);
    });
    return matched.sort((left, right) => {
      if (Boolean(left.virtual) !== Boolean(right.virtual)) return left.virtual ? -1 : 1;
      if (Boolean(left.installed) !== Boolean(right.installed)) return left.installed ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }, [filter, rows, search]);

  /** 顶部统计行：搜索时优先显示命中数 */
  let summaryText = `共 ${counts.all} 个插件 · 已安装 ${counts.installed}`;
  if (activeCategory) summaryText = `${activeCategory.label} · ${counts[activeCategory.id] ?? 0} 个插件`;
  if (search) summaryText = `搜索「${query.trim()}」· ${visibleRows.length} 个结果`;

  const runningTaskName = Object.values(tasks).find(task => task.status === 'running')?.name ?? null;
  const taskList = Object.values(tasks).sort((left, right) => right.startedAt - left.startedAt);
  const detailInstalled = Boolean(detailPlugin?.installed);
  const detailGithubUrl =
    detailState.status === 'ready'
      ? detailState.details.githubUrl
      : detailPlugin
        ? githubUrlFrom(detailPlugin.homepage)
        : undefined;
  const detailNpmUrl =
    detailState.status === 'ready'
      ? detailState.details.npmUrl
      : detailState.status === 'loading' || detailState.status === 'error'
        ? detailState.npmUrl
        : '';
  const detailFiles = useMemo(() => {
    if (!detailPlugin || detailPlugin.type !== 'app') return [];
    if (detailPlugin.virtual) {
      return appDirFiles.map(file => ({
        name: file.name,
        note: file.owner ? `属于 ${file.owner}` : '未知来源',
        installed: true,
      }));
    }
    const installed = new Set(detailPlugin.installedFiles ?? []);
    return appPluginFiles(detailPlugin).flatMap(file => {
      let name = '';
      try {
        name = appPluginFileName(file.url);
      } catch {
        return [];
      }
      const note = [file.name, file.description].filter(Boolean).join(' · ');
      return [{name, note: note || '未命名', installed: installed.has(name)}];
    });
  }, [appDirFiles, detailPlugin]);
  const pickerItems = useMemo(() => {
    if (!picker) return [];
    if (picker.mode === 'remove') {
      return removeTargets(picker.plugin).map(name => {
        const owner = dirOwners.get(name);
        return {
          label: name,
          note: marketFileLabel(picker.plugin, name) || (owner ? `属于 ${owner}` : '未知来源'),
        };
      });
    }
    return appPluginFiles(picker.plugin).map(file => ({label: file.name || file.url, note: file.description ?? ''}));
  }, [dirOwners, picker, removeTargets]);

  const updateTask = useCallback((name: string, updater: (task: PluginTask) => PluginTask) => {
    setTasks(current => (current[name] ? {...current, [name]: updater(current[name])} : current));
  }, []);

  const runTask = useCallback(
    async (plugin: Plugin, kind: TaskKind, options: TaskOptions = {}) => {
      const controller = new AbortController();
      taskCancellers.current[plugin.name] = controller;
      setExpanded(current => ({...current, [plugin.name]: false}));
      setTasks(current => ({
        ...current,
        [plugin.name]: {name: plugin.name, kind, status: 'running', startedAt: Date.now(), logs: []},
      }));
      setTasksOpen(true);
      const onLog = (line: string) => updateTask(plugin.name, task => ({...task, logs: [...task.logs, line]}));

      try {
        if (kind === 'remove') {
          await removePlugin(plugin, onLog, controller.signal, {appFiles: options.appFiles});
        } else {
          await installPlugin(plugin, onLog, controller.signal, {
            files: options.files,
            renames: options.renames,
            thirdParty: options.thirdParty,
          });
        }
        updateTask(plugin.name, task => ({...task, status: 'completed', endedAt: Date.now()}));
        await load(true);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        updateTask(plugin.name, task => ({
          ...task,
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          endedAt: Date.now(),
          logs: [...task.logs, message],
        }));
      } finally {
        delete taskCancellers.current[plugin.name];
      }
    },
    [load, updateTask],
  );

  const pickFiles = useCallback((plugin: Plugin, mode: 'install' | 'remove') => {
    const count = mode === 'remove' ? removeTargets(plugin).length : appPluginFiles(plugin).length;
    setSelectedFiles(Object.fromEntries(Array.from({length: count}, (_, index) => [String(index), false])));
    setPicker({mode, plugin});
  }, [removeTargets]);

  /**
   * app 插件落地前先看目录里有没有同名文件：
   * 同名且不属于这个插件，就交给用户决定替换还是重命名。
   */
  const startInstall = useCallback(
    (plugin: Plugin, files: PluginFile[], renames?: Record<string, string>, skipConflict = false) => {
      if (plugin.type !== 'app') {
        runTask(plugin, 'install', {files});
        return;
      }
      const names = files.flatMap(file => {
        try {
          return [appPluginFileName(file.url as string)];
        } catch {
          return [];
        }
      });
      const conflicts = names.filter(name => dirNames.has(name) && dirOwners.get(name) !== plugin.name);
      if (!skipConflict && conflicts.length) {
        setConflict({plugin, files, conflicts});
        return;
      }
      runTask(plugin, 'install', {files, renames});
    },
    [dirNames, dirOwners, runTask],
  );

  const requestInstall = useCallback(
    (plugin: Plugin) => {
      const files = appPluginFiles(plugin);
      if (plugin.type === 'app' && files.length > 1) {
        pickFiles(plugin, 'install');
        return;
      }
      startInstall(plugin, files);
    },
    [pickFiles, startInstall],
  );

  /**
   * 手动安装：现造一个单文件 app 条目，后面和市场的 app 插件走同一条安装流程。
   * 同名冲突在弹窗里已经提示过，这里直接开装，不再弹「替换 / 重命名」。
   */
  const submitManualInstall = useCallback(() => {
    try {
      const {plugin, files, renames} = manualAppPlugin(manualUrl, manualName);
      setManualOpen(false);
      setManualUrl('');
      setManualName('');
      setManualError('');
      runTask(plugin, 'install', {files, renames, thirdParty: true});
    } catch (caught) {
      setManualError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [manualName, manualUrl, runTask]);

  /**
   * git 插件安装：市场里没有的仓库，填地址（可选分支、目录名）后走市场那套 git 流程。
   * 目标目录已存在时是 fetch + reset --hard，等于覆盖安装。
   */
  const submitGitInstall = useCallback(() => {
    try {
      const plugin = manualGitPlugin(gitUrl, gitName, gitBranch);
      setGitOpen(false);
      setGitUrl('');
      setGitName('');
      setGitBranch('');
      setGitError('');
      runTask(plugin, 'install');
    } catch (caught) {
      setGitError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [gitBranch, gitName, gitUrl, runTask]);

  /**
   * 本地文件安装：原生选文件后直接复制进 rootfs 的 app 插件目录，
   * 不经过容器的 curl，也不记归属（未知来源）。
   */
  const importLocalAppPluginFile = useCallback(async () => {
    setInstallChoiceOpen(false);
    setManualError('');
    const taskName = '从本地文件安装';
    const pushTask = (status: TaskStatus, line: string) => {
      setTasks(current => {
        const previous = current[taskName];
        const base: PluginTask = previous ?? {
          name: taskName,
          kind: 'install',
          status: 'running',
          startedAt: Date.now(),
          logs: [],
        };
        return {
          ...current,
          [taskName]: {
            ...base,
            status,
            endedAt: status === 'running' ? undefined : Date.now(),
            logs: [...base.logs, line],
          },
        };
      });
      setTasksOpen(true);
    };

    pushTask('running', '请在系统文件选择器里选一个 .js 文件…');
    try {
      const file = await importLocalAppPlugin(APP_PLUGIN_ROOTFS_DIR);
      if (!file) {
        pushTask('cancelled', '已取消');
        return;
      }
      const suffix = /\.js$/i.test(file.name) ? '' : '（注意：Karin 只加载 .js，这个后缀不会生效）';
      pushTask('completed', `已导入 ${file.name}（${formatFileSize(file.size)}）到 plugins/${APP_PLUGIN_DIR}${suffix}`);
      await load(true);
    } catch (caught) {
      pushTask('failed', caught instanceof Error ? caught.message : String(caught));
    }
  }, [load]);

  const requestRemove = useCallback(
    (plugin: Plugin) => {
      if (plugin.type !== 'app') {
        runTask(plugin, 'remove');
        return;
      }
      const names = removeTargets(plugin);
      /** 多文件让用户挑要删的，只有一个文件就直接删 */
      if (names.length > 1) pickFiles(plugin, 'remove');
      else if (names.length === 1) runTask(plugin, 'remove', {appFiles: names});
    },
    [pickFiles, removeTargets, runTask],
  );

  const stopTask = useCallback((name: string) => {
    taskCancellers.current[name]?.abort();
  }, []);

  const openDetails = useCallback(async (plugin: Plugin) => {
    const requestId = ++detailRequestId.current;
    const npmUrl = npmPackageUrl(plugin.name);
    setDetailPlugin(plugin);
    if (plugin.type === 'app') {
      setDetailState({status: 'files'});
      return;
    }
    if (plugin.local && plugin.type === 'git') {
      setDetailState({status: 'local'});
      return;
    }
    setDetailState({status: 'loading', npmUrl});
    try {
      const details = await fetchPluginDetails(plugin);
      if (requestId !== detailRequestId.current) return;
      setDetailState({status: 'ready', details});
    } catch {
      if (requestId !== detailRequestId.current) return;
      setDetailState({status: 'error', npmUrl});
    }
  }, []);

  /** 安装步骤（本地文件 / 直链）就地盖在详情页上，不再另开一个 Modal */
  const closeInstallSteps = useCallback(() => {
    setInstallChoiceOpen(false);
    setManualOpen(false);
    setManualError('');
  }, []);

  /** 关详情页：安装步骤一起复位，下次打开不会停在上一步 */
  const closeDetail = useCallback(() => {
    setDetailPlugin(null);
    closeInstallSteps();
  }, [closeInstallSteps]);

  const openUrl = useCallback((url: string) => {
    Linking.openURL(url).catch(() => {});
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.summaryRow}>
        <Text style={[styles.summary, {color: colors.muted}]}>
          {summaryText}
        </Text>
        <Pressable
          accessibilityLabel='刷新插件列表'
          accessibilityRole='button'
          disabled={loading || refreshing}
          onPress={() => load(true)}
          style={[styles.refreshButton, {backgroundColor: colors.surface, borderColor: colors.border}]}>
          {refreshing ? (
            <ActivityIndicator color={colors.accent} size='small' />
          ) : (
            <RefreshCw color={colors.muted} size={15} />
          )}
        </Pressable>
      </View>

      <View
        style={[
          styles.searchRow,
          {backgroundColor: colors.neutralSoft, borderColor: search ? colors.accent : colors.border},
        ]}>
        <Search color={search ? colors.accent : colors.muted} size={14} />
        <TextInput
          accessibilityLabel='搜索插件'
          autoCapitalize='none'
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder='搜索插件名或介绍'
          placeholderTextColor={colors.muted}
          returnKeyType='search'
          style={[styles.searchInput, {color: colors.text}]}
          value={query}
        />
        {query ? (
          <Pressable accessibilityLabel='清空搜索' accessibilityRole='button' onPress={() => setQuery('')} style={styles.searchClear}>
            <X color={colors.muted} size={14} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.actionRow}>
        <Pressable
          accessibilityRole='button'
          onPress={onOpenDeps}
          style={[styles.actionPill, {backgroundColor: colors.surface, borderColor: colors.border}]}>
          <Package color={colors.accent} size={13} />
          <Text style={[styles.actionPillText, {color: colors.text}]}>依赖管理</Text>
        </Pressable>
        <Pressable
          accessibilityRole='button'
          onPress={() => {
            setGitError('');
            setGitOpen(true);
          }}
          style={[styles.actionPill, {backgroundColor: colors.surface, borderColor: colors.border}]}>
          <GitBranch color={colors.accent} size={13} />
          <Text style={[styles.actionPillText, {color: colors.text}]}>Git 安装</Text>
        </Pressable>
      </View>

      <View style={styles.filterBar}>
        {filtersOpen ? (
          <View style={styles.filterExpanded}>
            <View style={styles.filterHeader}>
              <Text style={[styles.filterTitle, {color: colors.muted}]}>全部筛选与分类</Text>
              <Pressable accessibilityRole='button' onPress={() => setFiltersOpen(false)} style={styles.filterCollapse}>
                <ChevronUp color={colors.muted} size={14} />
                <Text style={[styles.filterCollapseText, {color: colors.muted}]}>收起</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.filterWrap} style={styles.filterWrapScroll}>
              {filters.map(item => (
                <FilterChip
                  active={filter === item.id}
                  colors={colors}
                  count={counts[item.id] ?? 0}
                  Icon={item.Icon}
                  key={item.id}
                  label={item.label}
                  onPress={() => {
                    setFilter(item.id);
                    setFiltersOpen(false);
                  }}
                />
              ))}
            </ScrollView>
          </View>
        ) : (
          <>
            <ScrollView
              contentContainerStyle={styles.filterContent}
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.filterScroll}>
              {BASE_FILTERS.map(item => (
                <FilterChip
                  active={filter === item.id}
                  colors={colors}
                  count={counts[item.id] ?? 0}
                  Icon={item.Icon}
                  key={item.id}
                  label={item.label}
                  onPress={() => setFilter(item.id)}
                />
              ))}
            </ScrollView>
            {categoryFilters.length ? (
              <Pressable
                accessibilityLabel='展开筛选与分类'
                accessibilityRole='button'
                onPress={() => setFiltersOpen(true)}
                style={[
                  styles.filterToggle,
                  {
                    backgroundColor: activeCategory ? colors.accentSoft : colors.surface,
                    borderColor: activeCategory ? colors.accent : colors.border,
                  },
                ]}>
                <SlidersHorizontal color={activeCategory ? colors.accent : colors.muted} size={14} />
                <Text style={[styles.filterToggleText, {color: activeCategory ? colors.accent : colors.muted}]}>
                  {categoryFilters.length}
                </Text>
                <ChevronDown color={activeCategory ? colors.accent : colors.muted} size={13} />
              </Pressable>
            ) : null}
          </>
        )}
      </View>

      {loading ? (
        <View style={styles.state}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : error ? (
        <View style={styles.state}>
          <Text style={{color: colors.danger}}>{error}</Text>
          <Pressable onPress={() => load(true)}>
            <Text style={{color: colors.accent}}>重试</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.listContent}
          keyboardDismissMode='on-drag'
          keyboardShouldPersistTaps='handled'
          refreshControl={
            <RefreshControl
              colors={[colors.accent]}
              onRefresh={() => load(true)}
              refreshing={refreshing}
              tintColor={colors.accent}
            />
          }>
          {visibleRows.length === 0 ? (
            <Text style={[styles.empty, {color: colors.muted}]}>
              {rows.length === 0 ? '暂无插件' : search ? `没有匹配「${query.trim()}」的插件` : '没有符合条件的插件'}
            </Text>
          ) : (
            visibleRows.map(plugin => {
              const typeMeta = TYPE_META[plugin.type] ?? TYPE_META.npm;
              const running = runningTaskName === plugin.name;
              const disabled = runningTaskName !== null;
              const appFileCount = plugin.type === 'app' && !plugin.virtual ? appPluginFiles(plugin).length : 0;
              return (
                <Pressable
                  accessibilityRole='button'
                  android_ripple={{color: colors.accentSoft}}
                  key={plugin.name}
                  onPress={() => openDetails(plugin)}
                  style={[styles.card, {backgroundColor: colors.surface, borderColor: colors.border}]}>
                  <View style={[styles.typeIcon, {backgroundColor: colors.neutralSoft}]}>
                    <typeMeta.Icon color={colors[typeMeta.color]} size={16} />
                  </View>
                  <View style={styles.copy}>
                    <Text
                      numberOfLines={1}
                      style={[styles.name, plugin.virtual && styles.monoName, {color: colors.text}]}>
                      {plugin.name}
                    </Text>
                    <View style={styles.metaRow}>
                      <View style={[styles.tag, {backgroundColor: colors.neutralSoft}]}>
                        <Text style={[styles.tagText, {color: colors.muted}]}>
                          {plugin.virtual ? '目录' : typeMeta.label}
                        </Text>
                      </View>
                      {plugin.local ? (
                        <View style={[styles.tag, {backgroundColor: colors.orangeSoft}]}>
                          <Text style={[styles.tagText, {color: colors.orange}]}>未知来源</Text>
                        </View>
                      ) : null}
                      {pluginCategoryIds(plugin).map(id => (
                        <View key={id} style={[styles.tag, {backgroundColor: colors.accentSoft}]}>
                          <Text style={[styles.tagText, {color: colors.accent}]}>{CATEGORY_META[id]?.label ?? id}</Text>
                        </View>
                      ))}
                      {plugin.type === 'app' && plugin.installed && !plugin.virtual ? (
                        <Text style={[styles.badgeText, {color: colors.success}]}>
                          {`已安装 ${(plugin.installedFiles ?? []).length} 个文件`}
                        </Text>
                      ) : null}
                      {plugin.type === 'app' && !plugin.virtual && !plugin.installed && appFileCount > 1 ? (
                        <Text style={[styles.badgeText, {color: colors.muted}]}>{`${appFileCount} 个文件`}</Text>
                      ) : null}
                    </View>
                    <Text numberOfLines={2} style={[styles.desc, {color: colors.muted}]}>
                      {plugin.virtual
                        ? appDirFiles.length
                          ? `目录里现有 ${appDirFiles.length} 个 js 文件，可以逐个卸载`
                          : '暂未安装 APP 插件'
                        : plugin.description || '暂无描述'}
                    </Text>
                  </View>
                  <View style={styles.actions}>
                    {running ? (
                      <ActivityIndicator color={colors.accent} size='small' style={styles.actionSpinner} />
                    ) : plugin.virtual ? (
                      appDirFiles.length ? (
                        <Pressable
                          accessibilityRole='button'
                          disabled={disabled}
                          onPress={() => requestRemove(plugin)}
                          style={[
                            styles.action,
                            styles.removeAction,
                            {borderColor: colors.danger},
                            disabled && styles.disabledAction,
                          ]}>
                          <Trash2 color={colors.danger} size={13} />
                          <Text style={[styles.actionText, {color: colors.danger}]}>卸载</Text>
                        </Pressable>
                      ) : null
                    ) : plugin.installed ? (
                      <Pressable
                        accessibilityRole='button'
                        disabled={disabled}
                        onPress={() => requestRemove(plugin)}
                        style={[
                          styles.action,
                          styles.removeAction,
                          {borderColor: colors.danger},
                          disabled && styles.disabledAction,
                        ]}>
                        <Trash2 color={colors.danger} size={13} />
                        <Text style={[styles.actionText, {color: colors.danger}]}>卸载</Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        accessibilityRole='button'
                        disabled={disabled}
                        onPress={() => requestInstall(plugin)}
                        style={[styles.action, {backgroundColor: colors.accent}, disabled && styles.disabledAction]}>
                        <Download color='#fff' size={13} />
                        <Text style={styles.actionText}>安装</Text>
                      </Pressable>
                    )}
                  </View>
                </Pressable>
              );
            })
          )}
        </ScrollView>
      )}

      <DraggableFab badgeCount={taskList.length} colors={colors} onPress={() => setTasksOpen(true)} />
      <Modal animationType='slide' onRequestClose={() => setTasksOpen(false)} transparent visible={tasksOpen}>
        <View style={styles.overlay}>
          <Pressable onPress={() => setTasksOpen(false)} style={styles.overlayBackdrop} />
          <Animated.View
            style={[styles.bottomSheet, {backgroundColor: colors.surface}, {transform: [{translateY: sheetY}]}]}>
            <View style={styles.sheetHandle} />
            <View style={styles.taskHeader}>
              <Text style={[styles.name, {color: colors.text}]}>插件任务</Text>
              <Pressable onPress={() => setTasksOpen(false)}>
                <Text style={{color: colors.accent}}>关闭</Text>
              </Pressable>
            </View>
            <ScrollView nestedScrollEnabled>
              {taskList.length === 0 ? (
                <Text style={[styles.empty, {color: colors.muted}]}>暂无任务</Text>
              ) : (
                taskList.map(task => (
                  <TaskCard
                    colors={colors}
                    expanded={Boolean(expanded[task.name])}
                    key={`${task.name}-${task.startedAt}`}
                    onToggle={() => setExpanded(current => ({...current, [task.name]: !current[task.name]}))}
                    onStop={() => stopTask(task.name)}
                    task={task}
                  />
                ))
              )}
            </ScrollView>
          </Animated.View>
        </View>
      </Modal>

      <Modal
        animationType='fade'
        onRequestClose={() => setGitOpen(false)}
        transparent
        visible={gitOpen}>
        <View style={styles.overlay}>
          <Pressable onPress={() => setGitOpen(false)} style={styles.overlayBackdrop} />
          <View ref={gitStep} style={[styles.detailStep, styles.detailStepCenter, {paddingBottom: manualKeyboardInset}]}>
            <View style={[styles.manualSheet, {backgroundColor: colors.surface, borderColor: colors.border}]}>
              <Text style={[styles.name, {color: colors.text}]}>从 Git 仓库安装插件</Text>
              <Text style={[styles.filePickerHint, {color: colors.muted}]}>
                {`填仓库地址，clone 到 plugins/<目录名>，装完按未知来源列出；目录已存在时走 fetch + reset --hard 覆盖安装，会丢弃仓库里的本地改动。`}
              </Text>
              <TextInput
                autoCapitalize='none'
                autoCorrect={false}
                onChangeText={text => {
                  setGitUrl(text);
                  setGitError('');
                }}
                placeholder='https://github.com/xxx/karin-plugin-xxx'
                placeholderTextColor={colors.muted}
                style={[styles.manualInput, {borderColor: colors.border, color: colors.text}]}
                value={gitUrl}
              />
              <TextInput
                autoCapitalize='none'
                autoCorrect={false}
                onChangeText={setGitBranch}
                placeholder='分支（可选，默认仓库默认分支）'
                placeholderTextColor={colors.muted}
                style={[styles.manualInput, {borderColor: colors.border, color: colors.text}]}
                value={gitBranch}
              />
              <TextInput
                autoCapitalize='none'
                autoCorrect={false}
                onChangeText={text => {
                  setGitName(text);
                  setGitError('');
                }}
                placeholder={`目录名（可选，默认 ${gitPluginNameFromUrl(gitUrl) || '仓库名'}）`}
                placeholderTextColor={colors.muted}
                style={[styles.manualInput, {borderColor: colors.border, color: colors.text}]}
                value={gitName}
              />
              {gitError ? (
                <Text style={[styles.manualNote, {color: colors.danger}]}>{gitError}</Text>
              ) : gitTarget ? (
                <Text style={[styles.manualNote, {color: !gitNameValid || gitConflict ? colors.danger : colors.muted}]}>
                  {!gitNameValid
                    ? `目录名不合法：${gitTarget}`
                    : gitConflict
                      ? `已有同名插件 ${gitTarget}，安装会覆盖`
                      : `会装到 ${pluginInstallPath({name: gitTarget, type: 'git'})}`}
                </Text>
              ) : null}
              <View style={styles.conflictActions}>
                <Pressable onPress={() => setGitOpen(false)} style={[styles.conflictButton, {borderColor: colors.border}]}>
                  <Text style={[styles.conflictButtonText, {color: colors.muted}]}>取消</Text>
                </Pressable>
                <Pressable
                  disabled={!gitUrl.trim() || !gitNameValid}
                  onPress={submitGitInstall}
                  style={[
                    styles.conflictButton,
                    {backgroundColor: colors.accent, borderColor: colors.accent},
                    (!gitUrl.trim() || !gitNameValid) && styles.disabledAction,
                  ]}>
                  <Text style={[styles.conflictButtonText, styles.conflictPrimaryText]}>
                    {gitConflict ? '覆盖安装' : '安装'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        animationType='slide'
        onRequestClose={() => {
          if (installChoiceOpen || manualOpen) closeInstallSteps();
          else closeDetail();
        }}
        transparent
        visible={detailPlugin !== null}>
        <View style={styles.overlay}>
          <Pressable onPress={closeDetail} style={styles.overlayBackdrop} />
          <View style={[styles.detailSheet, {backgroundColor: colors.surface}]}>
            <View style={styles.sheetHandle} />
            <View style={styles.detailHeader}>
              <View style={styles.detailTitleWrap}>
                <Text numberOfLines={2} style={[styles.detailName, {color: colors.text}]}>
                  {detailPlugin?.name ?? ''}
                </Text>
                <Text numberOfLines={2} style={[styles.detailDescription, {color: colors.muted}]}>
                  {detailPlugin?.virtual
                    ? `plugins/${APP_PLUGIN_DIR}，所有 app 类型插件共享这个目录`
                    : detailPlugin?.description || '暂无描述'}
                </Text>
              </View>
              <Pressable
                accessibilityRole='button'
                onPress={closeDetail}
                style={[styles.detailClose, {backgroundColor: colors.neutralSoft}]}>
                <X color={colors.muted} size={16} />
              </Pressable>
            </View>
            <View style={styles.detailActions}>
              {detailPlugin && !detailPlugin.virtual ? (
                <Pressable
                  accessibilityRole='button'
                  onPress={() => {
                    const plugin = detailPlugin;
                    setDetailPlugin(null);
                    if (plugin.installed) requestRemove(plugin);
                    else requestInstall(plugin);
                  }}
                  style={[
                    styles.detailLink,
                    {
                      backgroundColor: detailInstalled ? colors.neutralSoft : colors.accentSoft,
                      borderColor: detailInstalled ? colors.danger : colors.accent,
                    },
                  ]}>
                  {detailInstalled ? (
                    <Trash2 color={colors.danger} size={14} />
                  ) : (
                    <Download color={colors.accent} size={14} />
                  )}
                  <Text style={[styles.detailLinkText, {color: detailInstalled ? colors.danger : colors.accent}]}>
                    {detailInstalled ? '卸载' : '安装'}
                  </Text>
                </Pressable>
              ) : null}
              {detailPlugin?.virtual ? (
                <Pressable
                  accessibilityRole='button'
                  onPress={() => setInstallChoiceOpen(true)}
                  style={[styles.detailLink, {backgroundColor: colors.accentSoft, borderColor: colors.accent}]}>
                  <Download color={colors.accent} size={14} />
                  <Text style={[styles.detailLinkText, {color: colors.accent}]}>安装</Text>
                </Pressable>
              ) : null}
              {detailPlugin?.virtual && appDirFiles.length ? (
                <Pressable
                  accessibilityRole='button'
                  onPress={() => {
                    const plugin = detailPlugin;
                    setDetailPlugin(null);
                    requestRemove(plugin);
                  }}
                  style={[styles.detailLink, {backgroundColor: colors.neutralSoft, borderColor: colors.danger}]}>
                  <Trash2 color={colors.danger} size={14} />
                  <Text style={[styles.detailLinkText, {color: colors.danger}]}>选择文件卸载</Text>
                </Pressable>
              ) : null}
              {detailGithubUrl ? (
                <Pressable
                  accessibilityRole='button'
                  onPress={() => openUrl(detailGithubUrl)}
                  style={[styles.detailLink, {borderColor: colors.border}]}>
                  <GithubIcon color={colors.text} size={14} />
                  <Text style={[styles.detailLinkText, {color: colors.text}]}>GitHub</Text>
                </Pressable>
              ) : null}
              {detailPlugin && detailPlugin.type !== 'app' && detailNpmUrl ? (
                <Pressable
                  accessibilityRole='button'
                  onPress={() => openUrl(detailNpmUrl)}
                  style={[styles.detailLink, {borderColor: colors.border}]}>
                  <NpmIcon color={colors.danger} size={14} />
                  <Text style={[styles.detailLinkText, {color: colors.text}]}>npm</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={styles.detailBody}>
              {detailState.status === 'files' ? (
                <ScrollView contentContainerStyle={styles.readmeContent} nestedScrollEnabled>
                  {detailPlugin?.virtual ? (
                    <Text style={[styles.appHint, {color: colors.muted}]}>
                      app 插件按单个 .js 文件加载，卸载时可以逐个选择；「安装」支持从本地文件或直链导入，两种方式装进来的都当未知来源（不记归属），带“属于”标记的是通过哈希匹配上插件市场的。
                    </Text>
                  ) : null}
                  {detailFiles.length === 0 ? (
                    <Text style={[styles.empty, {color: colors.muted}]}>暂未安装 APP 插件</Text>
                  ) : (
                    detailFiles.map(file => (
                      <View
                        key={file.name}
                        style={[styles.appFile, {backgroundColor: colors.neutralSoft, borderColor: colors.border}]}>
                        <View style={styles.appFileHead}>
                          {file.installed ? (
                            <CircleCheckBig color={colors.success} size={13} />
                          ) : (
                            <FileCode color={colors.muted} size={13} />
                          )}
                          <Text numberOfLines={1} style={[styles.appFileName, {color: colors.text}]}>
                            {file.name}
                          </Text>
                          <Text style={[styles.appFileState, {color: file.installed ? colors.success : colors.muted}]}>
                            {file.installed ? '已安装' : '未安装'}
                          </Text>
                        </View>
                        {file.note ? (
                          <Text numberOfLines={2} style={[styles.appFileDesc, {color: colors.muted}]}>
                            {file.note}
                          </Text>
                        ) : null}
                      </View>
                    ))
                  )}
                </ScrollView>
              ) : detailState.status === 'loading' ? (
                <View style={styles.detailStateBox}>
                  <ActivityIndicator color={colors.accent} size='small' />
                  <Text style={[styles.detailStateText, {color: colors.muted}]}>正在获取 README.md…</Text>
                </View>
              ) : detailState.status === 'local' ? (
                <View style={styles.detailStateBox}>
                  <Text style={[styles.detailStateText, {color: colors.text}]}>本地插件（未知来源）</Text>
                  <Text style={[styles.appHint, {color: colors.muted}]}>
                    {`插件市场里没有这个条目，它是从容器里的 ${detailPlugin ? pluginInstallPath(detailPlugin) : ''} 探测到的。git 插件没有 npm 上的 README 可看，可以直接卸载，卸载在依赖管理里也能做。`}
                  </Text>
                </View>
              ) : detailState.status === 'error' ? (
                <View style={styles.detailStateBox}>
                  <Text style={[styles.detailStateText, {color: colors.danger}]}>获取 README.md 失败</Text>
                  <Pressable
                    onPress={() => detailPlugin && openDetails(detailPlugin)}
                    style={[styles.detailRetry, {borderColor: colors.border}]}>
                    <RefreshCw color={colors.accent} size={13} />
                    <Text style={[styles.detailRetryText, {color: colors.accent}]}>重试</Text>
                  </Pressable>
                </View>
              ) : (
                <ScrollView contentContainerStyle={styles.readmeContent} nestedScrollEnabled>
                  <MarkdownView
                    baseUrl={detailState.details.githubUrl}
                    colors={colors}
                    markdown={detailState.details.readme}
                    onLinkPress={openUrl}
                  />
                </ScrollView>
              )}
            </View>
          </View>
          {installChoiceOpen ? (
            <View style={[styles.detailStep, styles.detailStepBottom]}>
              <Pressable onPress={closeInstallSteps} style={styles.overlayBackdrop} />
              <View style={[styles.conflictSheet, {backgroundColor: colors.surface}]}>
                <Text style={[styles.name, {color: colors.text}]}>安装 APP 插件</Text>
                <Text style={[styles.conflictBody, {color: colors.muted}]}>
                  {`两种方式装进来的文件都落在 plugins/${APP_PLUGIN_DIR}，统一按未知来源处理（不记归属），之后可以在这里逐个卸载。`}
                </Text>
                <Pressable
                  accessibilityRole='button'
                  disabled={!localImportAvailable}
                  onPress={importLocalAppPluginFile}
                  style={[styles.choiceButton, {borderColor: colors.border}, !localImportAvailable && styles.disabledAction]}>
                  <FileUp color={colors.accent} size={17} />
                  <View style={styles.choiceCopy}>
                    <Text style={[styles.choiceTitle, {color: colors.text}]}>从本地文件安装</Text>
                    <Text style={[styles.choiceNote, {color: colors.muted}]}>
                      {localImportAvailable
                        ? '选手机里的 .js 文件（下载目录、聊天里保存的文件等）'
                        : '当前安装的 App 还没有这个原生模块，重新构建安装后再试'}
                    </Text>
                  </View>
                </Pressable>
                <Pressable
                  accessibilityRole='button'
                  onPress={() => {
                    setInstallChoiceOpen(false);
                    setManualError('');
                    setManualOpen(true);
                  }}
                  style={[styles.choiceButton, {borderColor: colors.border}]}>
                  <Link2 color={colors.accent} size={17} />
                  <View style={styles.choiceCopy}>
                    <Text style={[styles.choiceTitle, {color: colors.text}]}>从直链下载</Text>
                    <Text style={[styles.choiceNote, {color: colors.muted}]}>填 GitHub 等文件地址，自动套用「GitHub 加速」</Text>
                  </View>
                </Pressable>
                <View style={styles.conflictActions}>
                  <Pressable
                    onPress={closeInstallSteps}
                    style={[styles.conflictButton, {borderColor: colors.border}]}>
                    <Text style={[styles.conflictButtonText, {color: colors.muted}]}>取消</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          ) : null}

          {manualOpen ? (
            <View
              ref={manualStep}
              style={[styles.detailStep, styles.detailStepCenter, {paddingBottom: manualKeyboardInset}]}>
              <Pressable onPress={closeInstallSteps} style={styles.overlayBackdrop} />
              <View style={[styles.manualSheet, {backgroundColor: colors.surface, borderColor: colors.border}]}>
                <Text style={[styles.name, {color: colors.text}]}>从直链安装 APP 插件</Text>
                <Text style={[styles.filePickerHint, {color: colors.muted}]}>
                  {`填文件直链，装进 plugins/${APP_PLUGIN_DIR}，按未知来源处理；文件名默认取直链里的名字，装完可以在文件列表里卸载。`}
                </Text>
                <TextInput
                  autoCapitalize='none'
                  autoCorrect={false}
                  onChangeText={text => {
                    setManualUrl(text);
                    setManualError('');
                  }}
                  placeholder='https://raw.githubusercontent.com/.../plugin.js'
                  placeholderTextColor={colors.muted}
                  style={[styles.manualInput, {borderColor: colors.border, color: colors.text}]}
                  value={manualUrl}
                />
                <TextInput
                  autoCapitalize='none'
                  autoCorrect={false}
                  onChangeText={text => {
                    setManualName(text);
                    setManualError('');
                  }}
                  placeholder={appPluginNameFromUrl(manualUrl) || '文件名，例如 my-plugin.js'}
                  placeholderTextColor={colors.muted}
                  style={[styles.manualInput, {borderColor: colors.border, color: colors.text}]}
                  value={manualName}
                />
                {manualError ? (
                  <Text style={[styles.manualNote, {color: colors.danger}]}>{manualError}</Text>
                ) : manualTarget ? (
                  <Text style={[styles.manualNote, {color: manualConflict ? colors.danger : colors.muted}]}>
                    {manualConflict
                      ? `已有同名文件 ${manualTarget}${dirOwners.get(manualTarget) ? `（属于 ${dirOwners.get(manualTarget)}）` : ''}，安装会覆盖`
                      : `会装成 ${manualTarget}`}
                  </Text>
                ) : null}
                <View style={styles.conflictActions}>
                  <Pressable
                    onPress={() => {
                      setManualOpen(false);
                      setInstallChoiceOpen(true);
                    }}
                    style={[styles.conflictButton, {borderColor: colors.border}]}>
                    <Text style={[styles.conflictButtonText, {color: colors.muted}]}>返回</Text>
                  </Pressable>
                  <Pressable
                    disabled={!manualUrl.trim()}
                    onPress={submitManualInstall}
                    style={[
                      styles.conflictButton,
                      {backgroundColor: colors.accent, borderColor: colors.accent},
                      !manualUrl.trim() && styles.disabledAction,
                    ]}>
                    <Text style={[styles.conflictButtonText, styles.conflictPrimaryText]}>
                      {manualConflict ? '覆盖安装' : '安装'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          ) : null}
        </View>
      </Modal>

      <Modal transparent visible={picker !== null} onRequestClose={() => setPicker(null)}>
        <View style={styles.overlay}>
          <Pressable onPress={() => setPicker(null)} style={styles.overlayBackdrop} />
          <View style={[styles.filePickerSheet, {backgroundColor: colors.surface}]}>
            <Text style={[styles.name, {color: colors.text}]}>
              {picker?.mode === 'remove'
                ? picker.plugin.virtual
                  ? '选择要卸载的 APP 插件文件'
                  : `选择要卸载的 ${picker.plugin.name} 文件`
                : '选择要安装的文件'}
            </Text>
            <Text style={[styles.filePickerHint, {color: colors.muted}]}>
              {picker?.mode === 'remove' ? '只会删除勾选的文件，默认不勾选' : '默认不勾选，勾选需要安装的文件'}
            </Text>
            <ScrollView style={styles.pickerList}>
              {pickerItems.map((item, index) => (
                <Pressable
                  key={`${item.label}-${index}`}
                  onPress={() =>
                    setSelectedFiles(current => ({...current, [String(index)]: !current[String(index)]}))
                  }
                  style={styles.fileChoice}>
                  <View style={styles.fileChoiceCopy}>
                    <Text numberOfLines={1} style={{color: colors.text}}>
                      {item.label}
                    </Text>
                    {item.note ? (
                      <Text numberOfLines={1} style={[styles.fileChoiceNote, {color: colors.muted}]}>
                        {item.note}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={{color: selectedFiles[String(index)] ? colors.accent : colors.muted}}>
                    {selectedFiles[String(index)] ? '✓' : '○'}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              disabled={!Object.values(selectedFiles).some(Boolean)}
              onPress={() => {
                if (!picker) return;
                const chosen = Object.keys(selectedFiles)
                  .filter(key => selectedFiles[key])
                  .map(Number);
                if (picker.mode === 'remove') {
                  const names = removeTargets(picker.plugin).filter((_, index) => chosen.includes(index));
                  if (names.length) runTask(picker.plugin, 'remove', {appFiles: names});
                } else {
                  const files = appPluginFiles(picker.plugin).filter((_, index) => chosen.includes(index));
                  startInstall(picker.plugin, files);
                }
                setPicker(null);
              }}
              style={[
                styles.fileInstallAction,
                {backgroundColor: colors.accent},
                !Object.values(selectedFiles).some(Boolean) && styles.disabledAction,
              ]}>
              <Text style={styles.actionText}>{picker?.mode === 'remove' ? '卸载所选' : '安装所选'}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal transparent visible={conflict !== null} onRequestClose={() => setConflict(null)}>
        <View style={styles.overlay}>
          <Pressable onPress={() => setConflict(null)} style={styles.overlayBackdrop} />
          <View style={[styles.conflictSheet, {backgroundColor: colors.surface}]}>
            <Text style={[styles.name, {color: colors.text}]}>文件重名</Text>
            <Text style={[styles.conflictBody, {color: colors.muted}]}>
              {`${APP_PLUGIN_DIR} 里已经有同名文件，而且不属于这个插件。替换会覆盖已有文件，重命名会把新文件改名后一起保留。`}
            </Text>
            <ScrollView style={styles.conflictList}>
              {conflict?.conflicts.map(name => (
                <Text key={name} style={[styles.conflictFile, {color: colors.text}]}>
                  {name}
                </Text>
              ))}
            </ScrollView>
            <View style={styles.conflictActions}>
              <Pressable
                onPress={() => setConflict(null)}
                style={[styles.conflictButton, {borderColor: colors.border}]}>
                <Text style={[styles.conflictButtonText, {color: colors.muted}]}>取消</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  if (!conflict) return;
                  const taken = new Set(dirNames);
                  const renames: Record<string, string> = {};
                  conflict.conflicts.forEach(name => {
                    const next = freeFileName(name, taken);
                    taken.add(next);
                    renames[name] = next;
                  });
                  startInstall(conflict.plugin, conflict.files, renames, true);
                  setConflict(null);
                }}
                style={[styles.conflictButton, {borderColor: colors.accent}]}>
                <Text style={[styles.conflictButtonText, {color: colors.accent}]}>重命名</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  if (!conflict) return;
                  startInstall(conflict.plugin, conflict.files, undefined, true);
                  setConflict(null);
                }}
                style={[styles.conflictButton, {backgroundColor: colors.danger, borderColor: colors.danger}]}>
                <Text style={[styles.conflictButtonText, styles.conflictPrimaryText]}>替换</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  summaryRow: {height: 38, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  summary: {fontSize: 11, fontWeight: '600'},
  refreshButton: {width: 30, height: 30, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center'},
  /** 依赖管理 / Git 安装入口 */
  actionRow: {flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 8},
  actionPill: {flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10},
  actionPillText: {fontSize: 11, fontWeight: '700'},
  searchRow: {
    minHeight: 36,
    marginHorizontal: 12,
    marginTop: 6,
    marginBottom: 6,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  searchInput: {flex: 1, fontSize: 12, paddingVertical: 4},
  searchClear: {width: 22, height: 22, alignItems: 'center', justifyContent: 'center'},
  filterBar: {flexDirection: 'row', alignItems: 'center', paddingRight: 12},
  filterScroll: {flexGrow: 0, flexShrink: 1},
  filterContent: {paddingHorizontal: 12, paddingBottom: 8, gap: 7},
  filterExpanded: {flex: 1},
  filterHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingBottom: 6},
  filterTitle: {fontSize: 11, fontWeight: '700'},
  filterCollapse: {flexDirection: 'row', alignItems: 'center', gap: 3},
  filterCollapseText: {fontSize: 11, fontWeight: '700'},
  filterWrapScroll: {flexGrow: 0, maxHeight: 148},
  filterWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingHorizontal: 12, paddingBottom: 8},
  filterToggle: {height: 30, borderRadius: 15, borderWidth: 1, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 8},
  filterToggleText: {fontSize: 11, fontWeight: '700'},
  chip: {height: 30, borderRadius: 15, borderWidth: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5},
  chipText: {fontSize: 12, fontWeight: '700'},
  chipCount: {fontSize: 10, fontWeight: '700', opacity: 0.75},
  listContent: {paddingBottom: 96},
  card: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 10,
    borderWidth: 1,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  typeIcon: {width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center'},
  copy: {flex: 1, gap: 4},
  name: {fontSize: 13, fontWeight: '700'},
  monoName: {fontFamily: 'monospace', fontSize: 11.5, lineHeight: 16},
  metaRow: {flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap'},
  tag: {borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1},
  tagText: {fontSize: 9, fontWeight: '700'},
  badgeText: {fontSize: 10, fontWeight: '700'},
  desc: {fontSize: 11, lineHeight: 16},
  actions: {alignItems: 'flex-end', gap: 6},
  action: {
    minHeight: 28,
    minWidth: 56,
    borderRadius: 7,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  removeAction: {borderWidth: 1, backgroundColor: 'transparent'},
  actionSpinner: {marginTop: 6, marginRight: 6},
  actionText: {color: '#fff', fontSize: 11, fontWeight: '700'},
  state: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12},
  empty: {textAlign: 'center', marginTop: 30},
  overlay: {flex: 1, alignItems: 'center', justifyContent: 'flex-end'},
  overlayBackdrop: {position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0, 0, 0, 0.35)'},
  bottomSheet: {height: 360, width: '100%', padding: 16, borderTopLeftRadius: 16, borderTopRightRadius: 16},
  sheetHandle: {alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: '#888', marginBottom: 10},
  taskHeader: {flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10},
  taskCard: {borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 8},
  taskCardHeader: {flexDirection: 'row', alignItems: 'center', gap: 8},
  taskToggleButton: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8},
  taskInfo: {flex: 1, gap: 4},
  taskName: {fontSize: 13, fontWeight: '700'},
  taskMeta: {flexDirection: 'row', alignItems: 'center', gap: 6},
  statusPill: {minWidth: 58, height: 20, borderRadius: 10, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3},
  statusText: {fontSize: 10, fontWeight: '700'},
  duration: {fontSize: 10},
  stopButton: {height: 30, borderRadius: 8, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4},
  stopButtonText: {color: '#fff', fontSize: 11, fontWeight: '700'},
  chevron: {transform: [{rotate: '0deg'}]},
  chevronExpanded: {transform: [{rotate: '180deg'}]},
  detailSheet: {height: '78%', width: '100%', padding: 16, borderTopLeftRadius: 16, borderTopRightRadius: 16},
  filePickerSheet: {width: '100%', padding: 16, borderTopLeftRadius: 16, borderTopRightRadius: 16},
  filePickerHint: {fontSize: 11, marginTop: 4, marginBottom: 4},
  pickerList: {maxHeight: 260},
  fileChoice: {paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10},
  fileChoiceCopy: {flex: 1, gap: 2},
  fileChoiceNote: {fontSize: 10},
  fileInstallAction: {minWidth: 72, minHeight: 32, borderRadius: 7, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 9, alignSelf: 'flex-end', marginTop: 6},
  disabledAction: {opacity: 0.45},
  detailHeader: {flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 12},
  detailTitleWrap: {flex: 1, gap: 4},
  detailName: {fontSize: 15, fontWeight: '800'},
  detailDescription: {fontSize: 11, lineHeight: 16},
  detailClose: {width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center'},
  detailActions: {flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap'},
  detailLink: {height: 30, borderWidth: 1, borderRadius: 15, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5},
  detailLinkText: {fontSize: 11, fontWeight: '700'},
  detailBody: {flex: 1},
  detailStateBox: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10},
  detailStateText: {fontSize: 12, fontWeight: '600'},
  detailRetry: {flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6},
  detailRetryText: {fontSize: 12, fontWeight: '700'},
  readmeContent: {paddingBottom: 20},
  appHint: {fontSize: 11, lineHeight: 17, marginBottom: 10},
  appFile: {borderWidth: 1, borderRadius: 9, padding: 9, marginBottom: 7, gap: 4},
  appFileHead: {flexDirection: 'row', alignItems: 'center', gap: 6},
  appFileName: {flex: 1, fontFamily: 'monospace', fontSize: 11},
  appFileState: {fontSize: 10, fontWeight: '700'},
  appFileDesc: {fontSize: 11, lineHeight: 16},
  conflictSheet: {width: '100%', padding: 16, borderTopLeftRadius: 16, borderTopRightRadius: 16, gap: 8},
  /** 安装步骤就地盖在详情页上，不再另开 Modal（Android 上两个 Modal 叠着会互相影响） */
  detailStep: {position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center'},
  /** 选安装方式贴底，和 sheet 一致 */
  detailStepBottom: {justifyContent: 'flex-end'},
  /** 直链表单居中；键盘弹出时靠 render 里的 paddingBottom 把内容整体往上让 */
  detailStepCenter: {justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 40},
  manualSheet: {width: '100%', padding: 16, borderWidth: 1, borderRadius: 14},
  manualInput: {borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 12, marginTop: 8},
  manualNote: {fontSize: 11, lineHeight: 16, marginTop: 8},
  /** 安装方式选择：本地文件 / 直链下载 */
  choiceButton: {flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, marginTop: 2},
  choiceCopy: {flex: 1, gap: 2},
  choiceTitle: {fontSize: 13, fontWeight: '700'},
  choiceNote: {fontSize: 11, lineHeight: 15},
  conflictBody: {fontSize: 12, lineHeight: 18},
  conflictList: {maxHeight: 120},
  conflictFile: {fontFamily: 'monospace', fontSize: 11, paddingVertical: 2},
  conflictActions: {flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4},
  conflictButton: {minHeight: 32, borderRadius: 7, borderWidth: 1, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center'},
  conflictButtonText: {fontSize: 12, fontWeight: '700'},
  conflictPrimaryText: {color: '#fff'},
});
