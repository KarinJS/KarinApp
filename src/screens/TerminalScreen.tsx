import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  BackHandler,
  Dimensions,
  FlatList,
  Keyboard,
  LayoutChangeEvent,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  ArrowDownToLine,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  Copy,
  CornerDownLeft,
  Eraser,
  ListChecks,
  RotateCw,
  X,
} from 'lucide-react-native';
import {karinService} from '../services/karinService';
import {setClipboardText} from '../services/clipboardService';
import {
  appendKarinLog,
  clearKarinLog,
  getKarinLogLines,
  KarinLogLine,
  KarinLogStream,
  subscribeKarinLog,
} from '../services/karinLogService';
import {
  formatLogFileLine,
  listLogDates,
  readLogLines,
  startLogTail,
  todayLogDate,
} from '../services/karinLogFileService';
import Toast from '../components/Toast';
import {useToast} from '../hooks/useToast';
import {Colors} from '../theme/colors';
import {ansiSegmentStyle} from '../utils/ansi';

type Props = {
  colors: Colors;
  dark: boolean;
  karinRunning: boolean;
  onBack: () => void;
};

/** 日志来源：「控制台」是 Karin 进程的 stdout 流（默认），「历史日志」读容器内 log4js 落盘文件（当天实时 + 历史日期）。 */
type LogMode = 'file' | 'console';

/** 距底部小于该距离就视为“贴底”，重新跟随最新日志。 */
const FOLLOW_THRESHOLD_PX = 28;
/** 文件日志在内存里保留的最大行数，与环形缓冲一致。 */
const FILE_MAX_LINES = 2000;
/** 文件日志高频追加的合并通知间隔。 */
const FILE_FLUSH_INTERVAL_MS = 120;

function lineColor(stream: KarinLogStream, colors: Colors): string {
  if (stream === 'stderr') return colors.danger;
  if (stream === 'input') return colors.accent;
  if (stream === 'system') return colors.muted;
  return colors.text;
}

/** 日期选择列表里的显示名：今天 / 昨天 / 完整日期。 */
function dateLabel(date: string): string {
  if (date === todayLogDate()) return '今天';
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const month = `${yesterday.getMonth() + 1}`.padStart(2, '0');
  const day = `${yesterday.getDate()}`.padStart(2, '0');
  if (date === `${yesterday.getFullYear()}-${month}-${day}`) return '昨天';
  return date;
}

/**
 * Karin 运行日志：「日志」模式读容器内 log4js 文件（当天 tail -F 实时跟随，可切历史日期），
 * 「控制台」模式是 Karin 常驻进程的 stdout 流（带 ANSI 颜色和控制台输入）。
 * 每行是独立的原生文本视图，系统选区跨不过行边界，所以不走系统选词：长按直接整行选中，
 * 再按 GitHub 手机版那样点选 / 长按选区间，凑多行一起复制。
 */
export default function TerminalScreen({colors, dark, karinRunning, onBack}: Props) {
  const [consoleLines, setConsoleLines] = useState<KarinLogLine[]>(() => getKarinLogLines());
  const [mode, setMode] = useState<LogMode>('console');
  const [date, setDate] = useState(() => todayLogDate());
  const [dates, setDates] = useState<string[]>([]);
  const [fileLines, setFileLines] = useState<KarinLogLine[]>([]);
  const [fileLoading, setFileLoading] = useState(false);
  const [dateSheetOpen, setDateSheetOpen] = useState(false);
  /** 点刷新重拉当前日期（含实时跟随重启）。 */
  const [reloadKey, setReloadKey] = useState(0);
  const [input, setInput] = useState('');
  const [follow, setFollow] = useState(true);
  const [selecting, setSelecting] = useState(false);
  /** 多选模式下选中的行 id；按 id 记录，日志被环形缓冲裁掉后自动落空。 */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(() => new Set());
  const {notice, showNotice} = useToast();
  const insets = useSafeAreaInsets();
  const [keyboardInset, setKeyboardInset] = useState(0);
  const root = useRef<React.ComponentRef<typeof View>>(null);
  const list = useRef<FlatList<KarinLogLine>>(null);
  const nextFileId = useRef(1);
  // 贴底偏移量自己算：FlatList 的 scrollToEnd 按各行已量出的高度估算末尾位置，长日志在行内
  // 换行撑高后估算值偏小，只能停在那一行的第一行文字上，所以用原生内容高度减可视高度。
  const contentHeight = useRef(0);
  const viewportHeight = useRef(0);
  const followRef = useRef(true);
  const dragging = useRef(false);
  /** 长按选区间时的锚点行。 */
  const anchorId = useRef<number | null>(null);
  /** 进入多选前是否在贴底，退出时按它决定要不要恢复跟随。 */
  const resumeFollow = useRef(false);

  const lines = mode === 'console' ? consoleLines : fileLines;

  const setFollowValue = useCallback((next: boolean) => {
    if (followRef.current === next) return;
    followRef.current = next;
    setFollow(next);
  }, []);

  const stickToBottom = useCallback((animated: boolean) => {
    if (viewportHeight.current <= 0) return;
    list.current?.scrollToOffset({
      offset: Math.max(0, contentHeight.current - viewportHeight.current),
      animated,
    });
  }, []);

  const backToBottom = useCallback(() => {
    setFollowValue(true);
    stickToBottom(true);
  }, [setFollowValue, stickToBottom]);

  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelectedIds(new Set());
    anchorId.current = null;
    if (!resumeFollow.current) return;
    resumeFollow.current = false;
    backToBottom();
  }, [backToBottom]);

  useEffect(() => subscribeKarinLog(() => setConsoleLines([...getKarinLogLines()])), []);

  // 文件日志数据源：当天用 tail -F 实时跟随，历史日期一次性读取。
  useEffect(() => {
    if (mode !== 'file') return;
    setFileLines([]);
    setFollowValue(true);
    const today = todayLogDate();
    if (date !== today) {
      let cancelled = false;
      setFileLoading(true);
      readLogLines(date)
        .then(rawLines => {
          if (cancelled) return;
          const formatted = rawLines
            .map(line => formatLogFileLine(line, nextFileId.current++))
            .filter((line): line is KarinLogLine => line !== null);
          setFileLines(formatted);
        })
        .catch(() => {
          // 文件不存在（那一天 Karin 没运行）或读取失败，按无日志展示
        })
        .finally(() => {
          if (!cancelled) setFileLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    // 当天：tail -F 自带末尾回放，之后实时追加；高频行合并渲染。
    const buffer: KarinLogLine[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (buffer.length === 0) return;
      const batch = buffer.splice(0, buffer.length);
      setFileLines(current => {
        const next = [...current, ...batch];
        return next.length > FILE_MAX_LINES ? next.slice(next.length - FILE_MAX_LINES) : next;
      });
    };
    const stop = startLogTail(date, line => {
      const formatted = formatLogFileLine(line, nextFileId.current++);
      if (!formatted) return;
      buffer.push(formatted);
      if (timer === null) timer = setTimeout(flush, FILE_FLUSH_INTERVAL_MS);
    });
    return () => {
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [mode, date, reloadKey, setFollowValue]);

  // 日志文件列表：进「日志」模式时拉一次，日期选择列表用。
  useEffect(() => {
    if (mode !== 'file') return;
    let cancelled = false;
    listLogDates()
      .then(available => {
        if (cancelled) return;
        const today = todayLogDate();
        setDates(available.includes(today) ? available : [today, ...available]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mode, reloadKey]);

  // Android 15 起 targetSdk 35+ 强制 edge-to-edge，manifest 里的 adjustResize 不再缩小窗口，
  // 输入法会直接盖住底部输入行。这里按容器在窗口里的真实底边算需要抬多高：窗口已经被系统缩过
  // 的设备（非 edge-to-edge）算出来是 0，不会重复抬。+ insets.bottom 是因为原生上报的键盘高度
  // 扣掉了导航栏，而 edge-to-edge 下内容本来就画到导航栏底下。
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', event => {
      const keyboardHeight = event.endCoordinates.height + insets.bottom;
      root.current?.measureInWindow((_x, y, _width, height) => {
        const bottomGap = Dimensions.get('screen').height - (y + height);
        setKeyboardInset(Math.max(0, Math.round(keyboardHeight - bottomGap)));
      });
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardInset(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [insets.bottom]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (dateSheetOpen) {
        setDateSheetOpen(false);
        return true;
      }
      if (selecting) {
        exitSelection();
        return true;
      }
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [dateSheetOpen, exitSelection, onBack, selecting]);

  // 内容变长时保持贴底；用户上滑查看历史则暂停跟随，不打断阅读。
  const handleContentSizeChange = (_width: number, height: number) => {
    contentHeight.current = height;
    if (followRef.current) stickToBottom(false);
  };

  const handleLayout = (event: LayoutChangeEvent) => {
    viewportHeight.current = event.nativeEvent.layout.height;
    if (followRef.current) stickToBottom(false);
  };

  /** 只有用户自己的手势才会改变跟随状态，程序化贴底触发的 onScroll 不算数。 */
  const followFromGesture = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent;
    const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
    setFollowValue(distance < FOLLOW_THRESHOLD_PX);
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const {contentSize, layoutMeasurement} = event.nativeEvent;
    contentHeight.current = contentSize.height;
    viewportHeight.current = layoutMeasurement.height;
    if (dragging.current) followFromGesture(event);
  };

  const handleScrollBeginDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    dragging.current = true;
    followFromGesture(event);
  };

  const handleScrollSettled = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    dragging.current = false;
    followFromGesture(event);
  };

  /** 切模式 / 切日期：退出多选并回到贴底跟随。 */
  const switchContext = (next: () => void) => {
    setSelecting(false);
    setSelectedIds(new Set());
    anchorId.current = null;
    next();
  };

  const send = () => {
    const text = input.trim();
    if (!text || !karinRunning) return;
    setInput('');
    setFollowValue(true);
    appendKarinLog(`$ ${text}`, 'input');
    karinService
      .sendInput(text)
      .catch(error =>
        appendKarinLog(`发送失败: ${error instanceof Error ? error.message : String(error)}`, 'stderr'),
      );
  };

  /** 进入多选：新日志会把列表顶走，先暂停跟随，退出时按 resumeFollow 恢复。 */
  const enterSelection = (id?: number) => {
    resumeFollow.current = followRef.current;
    setFollowValue(false);
    setSelecting(true);
    setSelectedIds(id === undefined ? new Set() : new Set([id]));
    anchorId.current = id ?? null;
  };

  const toggleLine = (id: number) => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchorId.current = id;
  };

  /** 长按：把锚点行到这一行之间整段选上（再长按可以继续从这一行往外扩）。 */
  const selectRange = (id: number) => {
    const from = anchorId.current;
    if (from === null) {
      enterSelection(id);
      return;
    }
    const fromIndex = lines.findIndex(line => line.id === from);
    const toIndex = lines.findIndex(line => line.id === id);
    if (fromIndex < 0 || toIndex < 0) {
      toggleLine(id);
      return;
    }
    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    setSelectedIds(current => {
      const next = new Set(current);
      for (let index = start; index <= end; index += 1) next.add(lines[index].id);
      return next;
    });
    anchorId.current = id;
  };

  const selectAll = () => {
    setSelectedIds(new Set(lines.map(line => line.id)));
  };

  /** 复制所选行：按行拼接纯文本（ANSI 颜色只在渲染时生效，不写进剪贴板）。 */
  const copySelected = () => {
    const picked = lines.filter(line => selectedIds.has(line.id));
    if (picked.length === 0) return;
    const text = picked.map(line => line.segments.map(segment => segment.text).join('')).join('\n');
    if (!setClipboardText(text)) {
      showNotice('复制失败：剪贴板不可用', 5000);
      return;
    }
    exitSelection();
    showNotice(`已复制 ${picked.length} 行日志`);
  };

  const selectedCount = lines.reduce(
    (count, line) => (selectedIds.has(line.id) ? count + 1 : count),
    0,
  );

  const today = todayLogDate();
  const dateChipLabel = date === today ? `今天 · ${date.slice(5)}` : date;

  return (
    <View ref={root} style={[styles.container, keyboardInset > 0 ? {paddingBottom: keyboardInset} : null]}>
      <View style={[styles.header, {borderBottomColor: colors.border}]}>
        <Pressable
          onPress={selecting ? exitSelection : onBack}
          style={styles.headerButton}
          accessibilityLabel={selecting ? '取消选择' : '返回'}>
          {selecting ? (
            <X size={19} color={colors.text} />
          ) : (
            <ChevronLeft size={20} color={colors.text} />
          )}
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={[styles.headerTitle, {color: colors.text}]}>
            {selecting ? `已选 ${selectedCount} 行` : '运行日志'}
          </Text>
          <Text numberOfLines={1} style={[styles.headerHint, {color: colors.muted}]}>
            {selecting
              ? '点行多选，长按选一段'
              : mode === 'file'
                ? `${dateChipLabel} · Karin 日志文件`
                : karinRunning
                  ? 'Karin 运行中 · 长按行选中复制'
                  : 'Karin 未运行'}
          </Text>
        </View>
        {selecting ? (
          <>
            <Pressable onPress={selectAll} style={styles.headerButton} accessibilityLabel="全选">
              <CheckCheck size={17} color={colors.text} />
            </Pressable>
            <Pressable
              onPress={copySelected}
              disabled={selectedCount === 0}
              style={styles.headerButton}
              accessibilityLabel="复制所选">
              <Copy size={17} color={selectedCount === 0 ? colors.muted : colors.accent} />
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              onPress={() => enterSelection()}
              style={styles.headerButton}
              accessibilityLabel="多选复制">
              <ListChecks size={17} color={colors.text} />
            </Pressable>
            {mode === 'file' ? (
              <Pressable
                onPress={() => switchContext(() => setReloadKey(key => key + 1))}
                style={styles.headerButton}
                accessibilityLabel="重新加载">
                <RotateCw size={16} color={colors.text} />
              </Pressable>
            ) : (
              <Pressable onPress={clearKarinLog} style={styles.headerButton} accessibilityLabel="清空日志">
                <Eraser size={17} color={colors.text} />
              </Pressable>
            )}
          </>
        )}
      </View>

      <View style={[styles.tabsRow, {borderBottomColor: colors.border}]}>
        <View style={[styles.modeGroup, {backgroundColor: colors.neutralSoft}]}>
          {(['console', 'file'] as LogMode[]).map(value => {
            const active = mode === value;
            return (
              <Pressable
                key={value}
                onPress={() => {
                  if (mode !== value) switchContext(() => setMode(value));
                }}
                style={[styles.modeTab, active ? {backgroundColor: colors.surface} : null]}
                accessibilityLabel={value === 'file' ? '历史日志' : '控制台'}>
                <Text style={[styles.modeTabText, {color: active ? colors.accent : colors.muted}]}>
                  {value === 'file' ? '历史日志' : '控制台'}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {mode === 'file' ? (
          <Pressable
            onPress={() => setDateSheetOpen(true)}
            style={[styles.dateChip, {borderColor: colors.border}]}
            accessibilityLabel="选择日期">
            <CalendarDays size={13} color={colors.muted} />
            <Text style={[styles.dateChipText, {color: colors.text}]}>{dateChipLabel}</Text>
            <ChevronDown size={13} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>

      <FlatList
        ref={list}
        data={lines}
        keyExtractor={item => `${item.id}`}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        renderItem={({item}) => {
          const color = lineColor(item.stream, colors);
          const body = item.segments.map((segment, index) => (
            <Text key={index} style={ansiSegmentStyle(segment, dark)}>
              {segment.text}
            </Text>
          ));
          // 每行是各自独立的原生文本视图，系统选区跨不过行边界，多选只能在 JS 侧做。
          if (!selecting) {
            return (
              <Text onLongPress={() => enterSelection(item.id)} style={[styles.line, {color}]}>
                {body}
              </Text>
            );
          }
          const isSelected = selectedIds.has(item.id);
          return (
            <Pressable
              onPress={() => toggleLine(item.id)}
              onLongPress={() => selectRange(item.id)}
              style={[styles.lineRow, isSelected ? {backgroundColor: colors.accentSoft} : null]}>
              <Text style={[styles.line, {color}]}>{body}</Text>
            </Pressable>
          );
        }}
        onContentSizeChange={handleContentSizeChange}
        onLayout={handleLayout}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollSettled}
        onMomentumScrollEnd={handleScrollSettled}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, {color: colors.muted}]}>
              {mode === 'file'
                ? fileLoading
                  ? '正在读取日志…'
                  : date === today
                    ? '今天还没有日志，Karin 运行后会自动记录'
                    : '这一天没有日志'
                : `暂无日志${karinRunning ? '' : '，启动 Karin 后显示运行日志'}`}
            </Text>
          </View>
        }
      />

      {!follow ? (
        <Pressable onPress={backToBottom} style={[styles.jump, {backgroundColor: colors.accentSoft}]}>
          <ArrowDownToLine size={14} color={colors.accent} />
          <Text style={[styles.jumpText, {color: colors.accent}]}>回到底部</Text>
        </Pressable>
      ) : null}

      {mode === 'console' ? (
        <View style={[styles.inputRow, {borderTopColor: colors.border, backgroundColor: colors.surface}]}>
          <Text style={[styles.prompt, {color: colors.accent}]}>$</Text>
          <TextInput
            value={input}
            onChangeText={setInput}
            onSubmitEditing={send}
            editable={karinRunning}
            placeholder={karinRunning ? '输入控制台命令，回车发送' : 'Karin 未运行'}
            placeholderTextColor={colors.muted}
            style={[styles.input, {color: colors.text}]}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
            submitBehavior="submit"
          />
          <Pressable
            onPress={send}
            disabled={!karinRunning || !input.trim()}
            style={[
              styles.sendButton,
              {backgroundColor: karinRunning && input.trim() ? colors.accent : colors.neutralSoft},
            ]}
            accessibilityLabel="发送">
            <CornerDownLeft size={16} color={karinRunning && input.trim() ? '#FFFFFF' : colors.muted} />
          </Pressable>
        </View>
      ) : null}

      <Modal visible={dateSheetOpen} transparent animationType="slide" onRequestClose={() => setDateSheetOpen(false)}>
        <Pressable style={styles.sheetOverlay} onPress={() => setDateSheetOpen(false)}>
          <View style={[styles.sheet, {backgroundColor: colors.surface}]} onStartShouldSetResponder={() => true}>
            <Text style={[styles.sheetTitle, {color: colors.text}]}>选择日期</Text>
            <ScrollView style={styles.sheetList}>
              {dates.length === 0 ? (
                <Text style={[styles.sheetEmpty, {color: colors.muted}]}>还没有日志文件</Text>
              ) : (
                dates.map(value => {
                  const active = value === date;
                  return (
                    <Pressable
                      key={value}
                      onPress={() => {
                        setDateSheetOpen(false);
                        if (value !== date) switchContext(() => setDate(value));
                      }}
                      style={[styles.sheetRow, {borderBottomColor: colors.border}]}>
                      <Text style={[styles.sheetRowText, {color: active ? colors.accent : colors.text}]}>
                        {dateLabel(value)}
                      </Text>
                      <Text style={[styles.sheetRowHint, {color: colors.muted}]}>{value}</Text>
                      {active ? <Check size={16} color={colors.accent} /> : null}
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>

      {notice ? <Toast message={notice} colors={colors} bottomOffset={64} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  header: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1},
  headerButton: {width: 34, height: 34, alignItems: 'center', justifyContent: 'center'},
  headerCopy: {flex: 1},
  headerTitle: {fontSize: 15, fontWeight: '800'},
  headerHint: {fontSize: 10, marginTop: 2},
  tabsRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1},
  modeGroup: {flexDirection: 'row', borderRadius: 8, padding: 2},
  modeTab: {borderRadius: 6, paddingHorizontal: 14, paddingVertical: 4},
  modeTabText: {fontSize: 11, fontWeight: '700'},
  dateChip: {flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5},
  dateChipText: {fontSize: 11, fontWeight: '600'},
  list: {flex: 1},
  listContent: {paddingHorizontal: 12, paddingVertical: 8},
  line: {fontFamily: 'monospace', fontSize: 11, lineHeight: 17},
  /** 多选模式下的行容器：负边距让高亮铺到列表内边距外，留一点圆角。 */
  lineRow: {marginHorizontal: -8, paddingHorizontal: 8, borderRadius: 4},
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60},
  emptyText: {fontSize: 12, fontWeight: '600'},
  jump: {position: 'absolute', alignSelf: 'center', bottom: 66, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6},
  jumpText: {fontSize: 11, fontWeight: '700'},
  inputRow: {flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, paddingHorizontal: 12, paddingVertical: 8},
  prompt: {fontFamily: 'monospace', fontSize: 13, fontWeight: '700'},
  input: {flex: 1, fontFamily: 'monospace', fontSize: 12, paddingVertical: 4},
  sendButton: {width: 34, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center'},
  sheetOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end'},
  sheet: {borderTopLeftRadius: 14, borderTopRightRadius: 14, maxHeight: '65%', paddingBottom: 16},
  sheetTitle: {fontSize: 14, fontWeight: '800', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6},
  sheetList: {maxHeight: 420},
  sheetRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth},
  sheetRowText: {fontSize: 13, fontWeight: '600', flex: 1},
  sheetRowHint: {fontSize: 11},
  sheetEmpty: {fontSize: 12, paddingHorizontal: 16, paddingVertical: 12},
});
