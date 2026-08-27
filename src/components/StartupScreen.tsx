import React from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';
import {Check, Circle} from 'lucide-react-native';
import {Colors} from '../theme/colors';
import {primaryTextStyle} from '../theme/styles';
import type {StartupProgress, StartupStage} from '../startup/startupTasks';

type Props = {
  colors: Colors;
  progress: StartupProgress;
  error: string;
  logPath: string;
  onRetry: () => void;
  onOpenLog: () => void;
};

const STEPS: {stage: StartupStage; label: string; detail: string}[] = [
  {stage: 'container', label: '初始化 proot 容器', detail: '首次启动时准备 Debian 文件系统'},
  {stage: 'proot', label: '启动 proot 容器', detail: '建立移动端运行环境'},
  {stage: 'environment', label: '检查运行环境', detail: '准备 Node.js、npm、pnpm 与 Karin'},
];

export default function StartupScreen({colors, progress, error, logPath, onRetry, onOpenLog}: Props) {
  const percent = Math.round(progress.progress * 100);
  const activeIndex = STEPS.findIndex(item => item.stage === progress.stage);
  const logs = progress.logs.slice(-4);

  return (
    <View style={[styles.container, {backgroundColor: colors.background}]}>
      <View style={[styles.mark, {backgroundColor: colors.accentSoft, borderColor: colors.border}]}>
        <Text style={[styles.markText, {color: colors.accent}]}>K</Text>
        <View style={[styles.spinner, {backgroundColor: colors.background}]}>
          <ActivityIndicator size="small" color={colors.accent} />
        </View>
      </View>

      <Text style={[styles.title, {color: colors.text}]}>Karin</Text>
      <Text style={[styles.subtitle, {color: colors.muted}]}>Android 运行环境</Text>

      <View style={styles.steps}>
        {STEPS.map((item, index) => {
          const complete = index < activeIndex || progress.progress === 1;
          const active = index === activeIndex && !error && !complete;
          return (
            <View key={item.stage} style={styles.step}>
              <View
                style={[
                  styles.stepIcon,
                  {
                    backgroundColor: complete
                      ? colors.successSoft
                      : active
                      ? colors.accentSoft
                      : colors.neutralSoft,
                  },
                ]}>
                {complete ? (
                  <Check size={15} strokeWidth={3} color={colors.success} />
                ) : active ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Circle size={12} color={colors.muted} />
                )}
              </View>
              <View style={styles.stepCopy}>
                <Text style={[styles.stepLabel, {color: complete || active ? colors.text : colors.muted}]}>
                  {item.label}
                </Text>
                <Text style={[styles.stepDetail, {color: colors.muted}]}>
                  {active ? progress.message : item.detail}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      <View style={[styles.progressTrack, {backgroundColor: colors.border}]}>
        <View
          style={[
            styles.progressFill,
            {backgroundColor: colors.accent, width: `${Math.max(4, percent)}%`},
          ]}
        />
      </View>
      <View style={styles.statusRow}>
        <Text numberOfLines={2} style={[styles.message, {color: colors.text}]}>
          {logPath ? '启动失败，完整日志已保存' : error || progress.message}
        </Text>
        <Text style={[styles.percent, {color: colors.accent}]}>{error ? '!' : `${percent}%`}</Text>
      </View>

      {error && logPath ? null : logs.length > 0 ? (
        <View style={[styles.log, {backgroundColor: colors.neutralSoft, borderColor: colors.border}]}>
          <Text style={[styles.logTitle, {color: colors.muted}]}>安装日志</Text>
          {logs.map((line, index) => (
            <Text key={`${index}-${line}`} numberOfLines={1} style={[styles.logLine, {color: colors.text}]}>
              {line}
            </Text>
          ))}
        </View>
      ) : !error ? (
        <Text style={[styles.hint, {color: colors.muted}]}>首次启动可能需要准备容器文件</Text>
      ) : null}

      {error ? (
        <>
          <Pressable onPress={onRetry} style={[styles.retryButton, {backgroundColor: colors.accent}]}>
            <Text style={primaryTextStyle}>重试</Text>
          </Pressable>
          {logPath ? (
            <View style={styles.logSaveBox}>
              <Text numberOfLines={2} style={[styles.logPath, {color: colors.muted}]}>
                完整日志已保存：{logPath}
              </Text>
              <Pressable
                onPress={onOpenLog}
                style={[styles.openLogButton, {borderColor: colors.border, backgroundColor: colors.surface}]}>
                <Text style={[styles.openLogText, {color: colors.text}]}>打开文件保存位置</Text>
              </Pressable>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, paddingHorizontal: 28, alignItems: 'center', justifyContent: 'center'},
  mark: {width: 76, height: 76, borderRadius: 24, borderWidth: 1, alignItems: 'center', justifyContent: 'center'},
  spinner: {position: 'absolute', right: -7, bottom: -7, width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center'},
  markText: {fontSize: 38, fontWeight: '900', letterSpacing: -2},
  title: {fontSize: 28, fontWeight: '900', marginTop: 18, letterSpacing: 0.4},
  subtitle: {fontSize: 12, fontWeight: '600', marginTop: 5},
  steps: {width: '100%', marginTop: 34, gap: 15},
  step: {flexDirection: 'row', alignItems: 'center', gap: 11},
  stepIcon: {width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center'},
  stepCopy: {flex: 1},
  stepLabel: {fontSize: 13, fontWeight: '800'},
  stepDetail: {fontSize: 10, marginTop: 2},
  progressTrack: {width: '100%', height: 5, borderRadius: 3, overflow: 'hidden', marginTop: 28},
  progressFill: {height: '100%', borderRadius: 3},
  statusRow: {width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 13},
  message: {flex: 1, marginRight: 8, fontSize: 13, fontWeight: '700'},
  percent: {fontSize: 12, fontWeight: '800'},
  hint: {fontSize: 11, marginTop: 11, alignSelf: 'flex-start'},
  log: {width: '100%', marginTop: 11, borderRadius: 9, borderWidth: 1, padding: 10, gap: 3},
  logTitle: {fontSize: 9, fontWeight: '700', marginBottom: 2, opacity: 0.85},
  logLine: {fontSize: 10, lineHeight: 14, fontVariant: ['tabular-nums']},
  retryButton: {minWidth: 92, minHeight: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 20},
  logSaveBox: {width: '100%', alignItems: 'center', marginTop: 14},
  logPath: {fontSize: 10, textAlign: 'center', marginBottom: 10},
  openLogButton: {minWidth: 140, minHeight: 38, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16},
  openLogText: {fontSize: 12, fontWeight: '700'},
});
