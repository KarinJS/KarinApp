import React, {useEffect, useRef, useState} from 'react';
import {
  BackHandler,
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {ArrowDownToLine, ChevronLeft, CornerDownLeft, Eraser} from 'lucide-react-native';
import {karinService} from '../services/karinService';
import {
  appendKarinLog,
  clearKarinLog,
  getKarinLogLines,
  KarinLogLine,
  KarinLogStream,
  subscribeKarinLog,
} from '../services/karinLogService';
import {Colors} from '../theme/colors';
import {ansiSegmentStyle} from '../utils/ansi';

type Props = {
  colors: Colors;
  dark: boolean;
  karinRunning: boolean;
  onBack: () => void;
};

/** 距底部小于该距离就视为“贴底”，重新跟随最新日志。 */
const FOLLOW_THRESHOLD_PX = 28;

function lineColor(stream: KarinLogStream, colors: Colors): string {
  if (stream === 'stderr') return colors.danger;
  if (stream === 'input') return colors.accent;
  if (stream === 'system') return colors.muted;
  return colors.text;
}

/** Karin 运行日志：实时滚动，保留 log4js 的 ANSI 颜色，长按用系统选择菜单复制。 */
export default function TerminalScreen({colors, dark, karinRunning, onBack}: Props) {
  const [lines, setLines] = useState<KarinLogLine[]>(() => getKarinLogLines());
  const [input, setInput] = useState('');
  const [follow, setFollow] = useState(true);
  const list = useRef<FlatList<KarinLogLine>>(null);

  useEffect(() => subscribeKarinLog(() => setLines([...getKarinLogLines()])), []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);

  // 内容变长时保持贴底；用户上滑查看历史则暂停跟随，不打断阅读。
  const handleContentSizeChange = () => {
    if (follow) list.current?.scrollToEnd({animated: false});
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent;
    const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
    setFollow(distance < FOLLOW_THRESHOLD_PX);
  };

  const send = () => {
    const text = input.trim();
    if (!text || !karinRunning) return;
    setInput('');
    setFollow(true);
    appendKarinLog(`$ ${text}`, 'input');
    karinService
      .sendInput(text)
      .catch(error =>
        appendKarinLog(`发送失败: ${error instanceof Error ? error.message : String(error)}`, 'stderr'),
      );
  };

  const backToBottom = () => {
    setFollow(true);
    list.current?.scrollToEnd({animated: true});
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, {borderBottomColor: colors.border}]}>
        <Pressable onPress={onBack} style={styles.headerButton} accessibilityLabel="返回">
          <ChevronLeft size={20} color={colors.text} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={[styles.headerTitle, {color: colors.text}]}>运行日志</Text>
          <Text numberOfLines={1} style={[styles.headerHint, {color: colors.muted}]}>
            {karinRunning ? 'Karin 运行中' : 'Karin 未运行'}
          </Text>
        </View>
        <Pressable onPress={clearKarinLog} style={styles.headerButton} accessibilityLabel="清空日志">
          <Eraser size={17} color={colors.text} />
        </Pressable>
      </View>

      <FlatList
        ref={list}
        data={lines}
        keyExtractor={item => `${item.id}`}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        renderItem={({item}) => (
          <Text selectable style={[styles.line, {color: lineColor(item.stream, colors)}]}>
            {item.segments.map((segment, index) => (
              <Text key={index} style={ansiSegmentStyle(segment, dark)}>
                {segment.text}
              </Text>
            ))}
          </Text>
        )}
        onContentSizeChange={handleContentSizeChange}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, {color: colors.muted}]}>
              暂无日志{karinRunning ? '' : '，启动 Karin 后显示运行日志'}
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
  list: {flex: 1},
  listContent: {paddingHorizontal: 12, paddingVertical: 8},
  line: {fontFamily: 'monospace', fontSize: 11, lineHeight: 17},
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60},
  emptyText: {fontSize: 12, fontWeight: '600'},
  jump: {position: 'absolute', alignSelf: 'center', bottom: 66, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6},
  jumpText: {fontSize: 11, fontWeight: '700'},
  inputRow: {flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, paddingHorizontal: 12, paddingVertical: 8},
  prompt: {fontFamily: 'monospace', fontSize: 13, fontWeight: '700'},
  input: {flex: 1, fontFamily: 'monospace', fontSize: 12, paddingVertical: 4},
  sendButton: {width: 34, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center'},
});
