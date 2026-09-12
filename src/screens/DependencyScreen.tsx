import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, BackHandler, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {ChevronLeft, RefreshCw, Trash2, X} from 'lucide-react-native';
import ConfirmDialog from '../components/ConfirmDialog';
import LogConsole from '../components/LogConsole';
import {Colors} from '../theme/colors';
import {primaryTextStyle} from '../theme/styles';
import {
  installKarinDependencies,
  KarinDependency,
  listKarinDependencies,
  parseDependencyInput,
  removeKarinDependency,
} from '../services/pluginService';

type Props = {
  colors: Colors;
  onBack: () => void;
};

type Run = {
  kind: 'install' | 'remove';
  target: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  logs: string[];
};

/**
 * 依赖管理：/root/karin/package.json 里声明的依赖（Karin 本体、插件、普通依赖都在这）。
 * 插件市场里没有的 npm 插件也在这里装，装完插件页会自动把它当成未知来源列出来。
 */
export default function DependencyScreen({colors, onBack}: Props) {
  const [deps, setDeps] = useState<KarinDependency[] | null>(null);
  const [listError, setListError] = useState('');
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [removeTarget, setRemoveTarget] = useState<KarinDependency | null>(null);
  const canceller = useRef<AbortController | null>(null);
  const busy = run?.status === 'running';

  const load = useCallback(() => {
    setDeps(null);
    setListError('');
    listKarinDependencies()
      .then(setDeps)
      .catch(error => setListError(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy) {
        canceller.current?.abort();
        return true;
      }
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [busy, onBack]);

  const start = useCallback(
    async (kind: Run['kind'], target: string, execute: (onLog: (line: string) => void, signal: AbortSignal) => Promise<string>) => {
      const controller = new AbortController();
      canceller.current = controller;
      setRun({kind, target, status: 'running', logs: []});
      const onLog = (line: string) => setRun(current => (current ? {...current, logs: [...current.logs, line]} : current));
      try {
        await execute(onLog, controller.signal);
        setRun(current => (current ? {...current, status: 'done'} : current));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setRun(current =>
          current
            ? {...current, status: controller.signal.aborted ? 'cancelled' : 'failed', logs: [...current.logs, message]}
            : current,
        );
      } finally {
        canceller.current = null;
        load();
      }
    },
    [load],
  );

  const submitInstall = useCallback(() => {
    if (busy) return;
    let names: string[] = [];
    try {
      names = parseDependencyInput(input);
    } catch (caught) {
      setInputError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    if (!names.length) {
      setInputError('请填写要安装的依赖名');
      return;
    }
    setInputError('');
    setInput('');
    start('install', names.join(' '), (onLog, signal) => installKarinDependencies(names, onLog, signal));
  }, [busy, input, start]);

  const confirmRemove = useCallback(() => {
    const target = removeTarget;
    setRemoveTarget(null);
    if (!target) return;
    start('remove', target.name, (onLog, signal) => removeKarinDependency(target.name, onLog, signal));
  }, [removeTarget, start]);

  const pluginCount = deps?.filter(dep => dep.plugin).length ?? 0;

  return (
    <View style={styles.container}>
      <View style={[styles.header, {borderBottomColor: colors.border}]}>
        <Pressable accessibilityLabel='返回插件页' onPress={onBack} style={styles.headerButton}>
          <ChevronLeft color={colors.text} size={20} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={[styles.headerTitle, {color: colors.text}]}>依赖管理</Text>
          <Text numberOfLines={1} style={[styles.headerPath, {color: colors.muted}]}>
            /root/karin/package.json
          </Text>
        </View>
        <Pressable accessibilityLabel='刷新依赖列表' onPress={load} style={styles.headerButton}>
          <RefreshCw color={colors.muted} size={17} />
        </Pressable>
      </View>

      <View style={styles.installRow}>
        <TextInput
          autoCapitalize='none'
          autoCorrect={false}
          editable={!busy}
          onChangeText={text => {
            setInput(text);
            setInputError('');
          }}
          onSubmitEditing={submitInstall}
          placeholder='karin-plugin-xxx karin-plugin-yyy@1.2.0'
          placeholderTextColor={colors.muted}
          returnKeyType='done'
          style={[styles.input, {backgroundColor: colors.surface, borderColor: inputError ? colors.danger : colors.border, color: colors.text}]}
          value={input}
        />
        <Pressable
          accessibilityRole='button'
          disabled={busy || !input.trim()}
          onPress={submitInstall}
          style={[
            styles.installButton,
            {backgroundColor: colors.accent, borderColor: colors.accent},
            (busy || !input.trim()) && styles.disabled,
          ]}>
          {busy ? <ActivityIndicator color='#FFFFFF' size='small' /> : <Text style={primaryTextStyle}>安装</Text>}
        </Pressable>
      </View>
      <Text style={[styles.hint, {color: inputError ? colors.danger : colors.muted}]}>
        {inputError || '一次可以装多个，用空格分隔（支持 name@version）；npm 插件按 karin-plugin-* / @karinjs/plugin-* / @scope/karin-plugin-* 命名。'}
      </Text>

      {run ? (
        <View style={[styles.runBox, {backgroundColor: colors.surface, borderColor: colors.border}]}>
          <View style={styles.runHead}>
            <Text numberOfLines={1} style={[styles.runTitle, {color: colors.text}]}>
              {`${run.kind === 'install' ? '安装' : '卸载'} ${run.target}`}
            </Text>
            {run.status === 'running' ? (
              <ActivityIndicator color={colors.accent} size='small' />
            ) : (
              <Text style={[styles.runState, {color: run.status === 'done' ? colors.success : colors.danger}]}>
                {run.status === 'done' ? '完成' : run.status === 'cancelled' ? '已终止' : '失败'}
              </Text>
            )}
            <Pressable
              accessibilityLabel={run.status === 'running' ? '终止任务' : '关闭日志'}
              onPress={() => (run.status === 'running' ? canceller.current?.abort() : setRun(null))}
              style={styles.runButton}>
              <X color={colors.muted} size={15} />
            </Pressable>
          </View>
          <LogConsole colors={colors} logs={run.logs} maxHeight={150} placeholder='等待输出…' />
        </View>
      ) : null}

      {deps === null && !listError ? (
        <View style={styles.state}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : listError ? (
        <View style={styles.state}>
          <Text style={[styles.stateText, {color: colors.danger}]}>{listError}</Text>
          <Pressable onPress={load} style={[styles.retry, {borderColor: colors.border}]}>
            <Text style={[styles.retryText, {color: colors.accent}]}>重试</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.listContent} keyboardShouldPersistTaps='handled'>
          <Text style={[styles.summary, {color: colors.muted}]}>
            {`共 ${deps?.length ?? 0} 个依赖 · 其中 ${pluginCount} 个是插件`}
          </Text>
          {(deps ?? []).map(dep => (
            <View
              key={dep.name}
              style={[styles.card, {backgroundColor: colors.surface, borderColor: colors.border}]}>
              <View style={styles.cardCopy}>
                <Text numberOfLines={1} style={[styles.name, {color: colors.text}]}>
                  {dep.name}
                </Text>
                <View style={styles.metaRow}>
                  {dep.spec ? (
                    <Text numberOfLines={1} style={[styles.spec, {color: colors.muted}]}>
                      {dep.spec}
                    </Text>
                  ) : null}
                  {dep.plugin ? (
                    <View style={[styles.tag, {backgroundColor: colors.accentSoft}]}>
                      <Text style={[styles.tagText, {color: colors.accent}]}>插件</Text>
                    </View>
                  ) : null}
                  {dep.core ? (
                    <View style={[styles.tag, {backgroundColor: colors.orangeSoft}]}>
                      <Text style={[styles.tagText, {color: colors.orange}]}>核心</Text>
                    </View>
                  ) : null}
                  {dep.dev ? (
                    <View style={[styles.tag, {backgroundColor: colors.neutralSoft}]}>
                      <Text style={[styles.tagText, {color: colors.muted}]}>dev</Text>
                    </View>
                  ) : null}
                </View>
              </View>
              {dep.core ? (
                <Text style={[styles.locked, {color: colors.muted}]}>不可卸载</Text>
              ) : (
                <Pressable
                  accessibilityRole='button'
                  disabled={busy}
                  onPress={() => setRemoveTarget(dep)}
                  style={[styles.removeButton, {borderColor: colors.danger}, busy && styles.disabled]}>
                  <Trash2 color={colors.danger} size={13} />
                  <Text style={[styles.removeText, {color: colors.danger}]}>卸载</Text>
                </Pressable>
              )}
            </View>
          ))}
          {deps && deps.length === 0 ? (
            <Text style={[styles.empty, {color: colors.muted}]}>package.json 里还没声明依赖</Text>
          ) : null}
          <Text style={[styles.footnote, {color: colors.muted}]}>
            {`卸载会同步 pnpm 与 package.json，插件页的状态会跟着刷新；装进来的 npm 插件只要符合命名约定，插件页就会以「未知来源」列出来。`}
          </Text>
        </ScrollView>
      )}

      <ConfirmDialog
        colors={colors}
        title='卸载依赖'
        body={`将从 /root/karin 卸载 ${removeTarget?.name ?? ''}${
          removeTarget?.plugin ? '。它是插件，卸载后插件页里的条目会一起消失' : '。如果不是插件，卸载可能影响 Karin 运行'
        }。`}
        confirmText='卸载'
        visible={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={confirmRemove}
      />

    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  header: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1},
  headerButton: {width: 34, height: 34, alignItems: 'center', justifyContent: 'center'},
  headerCopy: {flex: 1},
  headerTitle: {fontSize: 15, fontWeight: '800'},
  headerPath: {fontFamily: 'monospace', fontSize: 10, marginTop: 2},
  installRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10},
  input: {flex: 1, minHeight: 38, borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, fontSize: 12},
  installButton: {minWidth: 62, minHeight: 38, borderWidth: 1, borderRadius: 9, alignItems: 'center', justifyContent: 'center'},
  disabled: {opacity: 0.45},
  hint: {fontSize: 11, lineHeight: 16, paddingHorizontal: 12, paddingTop: 6},
  runBox: {marginHorizontal: 12, marginTop: 10, borderWidth: 1, borderRadius: 10, padding: 10},
  runHead: {flexDirection: 'row', alignItems: 'center', gap: 8},
  runTitle: {flex: 1, fontFamily: 'monospace', fontSize: 11},
  runState: {fontSize: 11, fontWeight: '700'},
  runButton: {width: 26, height: 26, alignItems: 'center', justifyContent: 'center'},
  state: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 20},
  stateText: {fontSize: 12, textAlign: 'center'},
  retry: {borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6},
  retryText: {fontSize: 12, fontWeight: '700'},
  listContent: {padding: 12, paddingBottom: 24, gap: 8},
  summary: {fontSize: 11},
  card: {flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9},
  cardCopy: {flex: 1, gap: 4},
  name: {fontFamily: 'monospace', fontSize: 12, fontWeight: '600'},
  metaRow: {flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap'},
  spec: {fontSize: 10},
  tag: {borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1},
  tagText: {fontSize: 9, fontWeight: '700'},
  locked: {fontSize: 10, fontWeight: '700'},
  removeButton: {flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 28, borderWidth: 1, borderRadius: 7, paddingHorizontal: 9},
  removeText: {fontSize: 11, fontWeight: '700'},
  empty: {textAlign: 'center', marginTop: 20},
  footnote: {fontSize: 10.5, lineHeight: 15, marginTop: 4},
});
