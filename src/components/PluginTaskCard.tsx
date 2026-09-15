import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Animated, PanResponder, Pressable, StyleSheet, Text, View} from 'react-native';
import {ChevronDown, Download, Trash2, XCircle, AlertTriangle} from 'lucide-react-native';
import LogConsole from './LogConsole';
import {Colors} from '../theme/colors';
import type {PluginTask, PluginTaskStatus} from '../hooks/usePluginTasks';

const statusStyle = (status: PluginTaskStatus, colors: Colors) => {
  if (status === 'running') return {label: '运行中', background: colors.accentSoft, color: colors.accent};
  if (status === 'warning') return {label: '警告', background: colors.orangeSoft, color: colors.orange};
  if (status === 'completed') return {label: '已完成', background: colors.successSoft, color: colors.success};
  if (status === 'cancelled') return {label: '已终止', background: colors.neutralSoft, color: colors.muted};
  return {label: '失败', background: colors.neutralSoft, color: colors.danger};
};

const formatDuration = (milliseconds: number) => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

type Props = {
  colors: Colors;
  expanded: boolean;
  onToggle: () => void;
  onStop: () => void;
  onDelete: () => void;
  onWarning: () => void;
  task: PluginTask;
};

/** 任务卡：独立警告入口、日志展开，以及已完成任务的双向滑动删除。 */
export default function PluginTaskCard({colors, expanded, onToggle, onStop, onDelete, onWarning, task}: Props) {
  const running = task.status === 'running' || task.status === 'warning';
  const completed = task.status === 'completed';
  const status = statusStyle(task.status, colors);
  const [now, setNow] = useState(task.startedAt);
  const translateX = useRef(new Animated.Value(0)).current;
  const originX = useRef(0);
  const width = useRef(0);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_event, gesture) =>
      completed && Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.3,
    onPanResponderGrant: () => {
      translateX.stopAnimation(value => { originX.current = value; });
    },
    onPanResponderMove: (_event, gesture) => translateX.setValue(originX.current + gesture.dx),
    onPanResponderRelease: (_event, gesture) => {
      if (completed && Math.abs(gesture.dx) > 72) {
        Animated.timing(translateX, {
          toValue: (gesture.dx < 0 ? -1 : 1) * (width.current + 32),
          duration: 160,
          useNativeDriver: true,
        }).start(({finished}) => { if (finished) onDelete(); });
      } else {
        Animated.spring(translateX, {toValue: 0, useNativeDriver: true}).start();
      }
    },
    onPanResponderTerminate: () => Animated.spring(translateX, {toValue: 0, useNativeDriver: true}).start(),
  }), [completed, onDelete, translateX]);

  const elapsed = (task.endedAt ?? now) - task.startedAt;
  return (
    <Animated.View
      onLayout={event => { width.current = event.nativeEvent.layout.width; }}
      style={[
        styles.card,
        {backgroundColor: colors.neutralSoft, borderColor: colors.border, transform: [{translateX}]},
      ]}>
      <View {...panResponder.panHandlers} style={styles.header}>
        {task.kind === 'remove' ? (
          <Trash2 size={15} color={colors.danger} />
        ) : (
          <Download size={15} color={colors.accent} />
        )}
        <View style={styles.info}>
          <Pressable
            accessibilityLabel={`${expanded ? '收起' : '查看'} ${task.name} 的任务日志`}
            accessibilityRole='button'
            accessibilityState={{expanded}}
            onPress={onToggle}
            style={styles.titleRow}>
            <Text numberOfLines={1} style={[styles.name, {color: colors.text}]}>{task.name}</Text>
            <ChevronDown color={colors.muted} size={16} style={expanded ? styles.chevronExpanded : undefined} />
          </Pressable>
          <View style={styles.meta}>
            <Pressable
              accessibilityLabel={task.warning ? '查看安装警告并处理' : undefined}
              accessibilityRole={task.warning ? 'button' : undefined}
              disabled={!task.warning || task.cancelling}
              hitSlop={4}
              onPress={onWarning}
              style={[styles.pill, {backgroundColor: status.background}]}>
              {task.status === 'warning' ? (
                <AlertTriangle color={status.color} size={12} />
              ) : running ? (
                <ActivityIndicator color={status.color} size='small' />
              ) : null}
              <Text style={[styles.status, {color: status.color}]}>
                {task.cancelling ? '终止中' : status.label}
              </Text>
            </Pressable>
            <Text style={[styles.duration, {color: colors.muted}]}>用时 {formatDuration(elapsed)}</Text>
          </View>
        </View>
        {running ? (
          <Pressable
            accessibilityLabel={`终止 ${task.name}`}
            accessibilityRole='button'
            disabled={task.cancelling}
            onPress={onStop}
            style={[styles.stop, {backgroundColor: colors.danger}, task.cancelling && styles.disabled]}>
            <XCircle color='#fff' size={14} />
            <Text style={styles.stopText}>终止</Text>
          </Pressable>
        ) : null}
      </View>
      {task.warning ? (
        <Pressable accessibilityRole='button' onPress={onWarning} style={styles.warningHint}>
          <Text style={[styles.warningText, {color: colors.orange}]}>点击「警告」查看原因并处理</Text>
        </Pressable>
      ) : null}
      {expanded ? (
        <LogConsole colors={colors} logs={task.logs} maxHeight={180} placeholder='等待任务日志…' />
      ) : null}
      {completed ? (
        <Text style={[styles.swipeHint, {color: colors.muted}]}>左右滑动删除任务</Text>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 8},
  header: {flexDirection: 'row', alignItems: 'center', gap: 8},
  info: {flex: 1, gap: 4},
  titleRow: {flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 25},
  name: {flex: 1, fontSize: 13, fontWeight: '700'},
  meta: {flexDirection: 'row', alignItems: 'center', gap: 6},
  pill: {minWidth: 58, height: 24, borderRadius: 12, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3},
  status: {fontSize: 10, fontWeight: '700'},
  duration: {fontSize: 10},
  stop: {height: 30, borderRadius: 8, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4},
  stopText: {color: '#fff', fontSize: 11, fontWeight: '700'},
  disabled: {opacity: 0.45},
  warningHint: {paddingTop: 8, paddingBottom: 2},
  warningText: {fontSize: 11},
  chevronExpanded: {transform: [{rotate: '180deg'}]},
  swipeHint: {fontSize: 9, marginTop: 5, textAlign: 'right'},
});
