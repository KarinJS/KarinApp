import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {ArrowLeftRight, Check, RefreshCw, X} from 'lucide-react-native';
import {Colors} from '../theme/colors';
import type {Plugin} from '../services/pluginService';
import {fetchPluginVersionList} from '../services/pluginVersionService';

type VersionList = Awaited<ReturnType<typeof fetchPluginVersionList>>;
type Props = {
  plugin: Plugin;
  colors: Colors;
  busy: boolean;
  onSelect: (version: string) => void;
  onClose: () => void;
};

/** 直接盖在插件详情 Modal 内，返回键由详情页先关闭此面板。 */
export default function PluginVersionSheet({plugin, colors, busy, onSelect, onClose}: Props) {
  const insets = useSafeAreaInsets();
  const requestId = useRef(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [data, setData] = useState<VersionList | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const git = plugin.type === 'git';

  const load = useCallback(async (force = false) => {
    const request = ++requestId.current;
    setState('loading');
    setError('');
    setSelected('');
    setData(null);
    try {
      const next = await fetchPluginVersionList(plugin, {force});
      if (request !== requestId.current) return;
      setData(next);
      setState('ready');
    } catch (caught) {
      if (request !== requestId.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setState('error');
    }
  }, [plugin]);

  useEffect(() => {
    load();
    return () => { requestId.current += 1; };
  }, [load]);

  const canSubmit = state === 'ready' && !busy && Boolean(selected) && selected !== data?.current;
  const current = data?.current ? git ? data.current.slice(0, 8) : data.current : '未知';

  return (
    <View style={styles.overlay}>
      <Pressable accessibilityLabel='关闭版本选择' onPress={onClose} style={StyleSheet.absoluteFill} />
      <View style={[styles.sheet, {backgroundColor: colors.surface, paddingBottom: Math.max(insets.bottom, 12)}]}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={[styles.title, {color: colors.text}]}>切换版本</Text>
            <Text numberOfLines={1} style={[styles.name, {color: colors.muted}]}>{plugin.name}</Text>
          </View>
          <Pressable accessibilityLabel='关闭版本选择' accessibilityRole='button' onPress={onClose} style={styles.iconButton}>
            <X size={18} color={colors.muted} />
          </Pressable>
        </View>
        <View style={[styles.currentRow, {backgroundColor: colors.neutralSoft}]}>
          <Text style={[styles.currentLabel, {color: colors.muted}]}>{git ? '当前提交' : '当前版本'}</Text>
          <Text numberOfLines={1} style={[styles.currentValue, {color: colors.text}]}>{state === 'loading' ? '读取中…' : current}</Text>
        </View>
        <View style={styles.listHeader}>
          <Text style={[styles.listTitle, {color: colors.text}]}>{git ? '最近 100 条提交' : '已发布版本'}</Text>
          <Pressable
            accessibilityLabel='刷新版本列表'
            accessibilityRole='button'
            disabled={state === 'loading'}
            onPress={() => load(true)}
            style={[styles.refresh, state === 'loading' && styles.disabled]}>
            <RefreshCw size={13} color={colors.accent} />
            <Text style={[styles.refreshText, {color: colors.accent}]}>刷新</Text>
          </Pressable>
        </View>
        {data?.warning ? <Text style={[styles.warning, {color: colors.orange, backgroundColor: colors.orangeSoft}]}>{data.warning}</Text> : null}
        {state === 'loading' ? (
          <View style={styles.state}>
            <ActivityIndicator color={colors.accent} size='small' />
            <Text style={[styles.stateText, {color: colors.muted}]}>{git ? '正在读取提交记录…' : '正在获取版本列表…'}</Text>
          </View>
        ) : state === 'error' ? (
          <View style={styles.state}>
            <Text style={[styles.stateText, {color: colors.danger}]}>{error || '版本列表读取失败'}</Text>
            <Pressable accessibilityRole='button' onPress={() => load(true)} style={[styles.retry, {borderColor: colors.border}]}>
              <Text style={[styles.refreshText, {color: colors.accent}]}>重试</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={data?.versions ?? []}
            extraData={{selected, busy, current: data?.current}}
            keyExtractor={item => item.value}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={<Text style={[styles.empty, {color: colors.muted}]}>{git ? '暂无可切换的提交' : '暂无可切换的版本'}</Text>}
            renderItem={({item}) => {
              const active = item.value === data?.current;
              const chosen = item.value === selected;
              return (
                <Pressable
                  accessibilityRole='radio'
                  accessibilityState={{selected: chosen, disabled: busy || active}}
                  disabled={busy || active}
                  onPress={() => setSelected(item.value)}
                  style={[styles.versionRow, {borderBottomColor: colors.border, backgroundColor: chosen ? colors.accentSoft : colors.surface}]}>
                  <View style={styles.versionCopy}>
                    {git ? <Text style={[styles.hash, {color: active || chosen ? colors.accent : colors.muted}]}>{item.value.slice(0, 8)}</Text> : null}
                    <Text numberOfLines={git ? 2 : 1} style={[styles.versionLabel, {color: active || chosen ? colors.accent : colors.text}]}>{item.label}</Text>
                    {item.description ? <Text numberOfLines={2} style={[styles.description, {color: colors.muted}]}>{item.description}</Text> : null}
                  </View>
                  {active ? <Text style={[styles.currentTag, {color: colors.accent}]}>当前</Text> : chosen ? <Check size={17} color={colors.accent} /> : null}
                </Pressable>
              );
            }}
          />
        )}
        <View style={[styles.footer, {borderTopColor: colors.border}]}>
          <Text numberOfLines={1} style={[styles.selection, {color: colors.muted}]}>
            {busy ? '当前任务结束后可切换' : selected ? `已选择 ${git ? selected.slice(0, 8) : selected}` : git ? '请选择要切换的提交' : '请选择要切换的版本'}
          </Text>
          <Pressable
            accessibilityRole='button'
            accessibilityState={{disabled: !canSubmit}}
            disabled={!canSubmit}
            onPress={() => { if (canSubmit) onSelect(selected); }}
            style={[styles.submit, {backgroundColor: colors.accent}, !canSubmit && styles.disabled]}>
            <ArrowLeftRight size={15} color='#fff' />
            <Text style={styles.submitText}>切换</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {...StyleSheet.absoluteFill, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)'},
  sheet: {height: '82%', borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 9},
  handle: {width: 34, height: 4, borderRadius: 3, backgroundColor: '#B7A3AA', alignSelf: 'center', marginBottom: 10},
  header: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16},
  headerCopy: {flex: 1, gap: 3},
  title: {fontSize: 14, fontWeight: '800'},
  name: {fontSize: 11, fontFamily: 'monospace'},
  iconButton: {width: 36, height: 36, alignItems: 'center', justifyContent: 'center'},
  currentRow: {marginHorizontal: 16, marginTop: 12, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 10},
  currentLabel: {fontSize: 11},
  currentValue: {flex: 1, textAlign: 'right', fontSize: 12, fontFamily: 'monospace', fontWeight: '700'},
  listHeader: {paddingHorizontal: 16, paddingTop: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  listTitle: {fontSize: 11.5, fontWeight: '700'},
  refresh: {minHeight: 36, paddingHorizontal: 4, flexDirection: 'row', alignItems: 'center', gap: 4},
  refreshText: {fontSize: 11, fontWeight: '700'},
  warning: {fontSize: 11, lineHeight: 16, padding: 9, marginHorizontal: 16, marginBottom: 6, borderRadius: 8},
  list: {flex: 1},
  listContent: {paddingHorizontal: 16, paddingBottom: 8},
  versionRow: {minHeight: 44, paddingVertical: 10, paddingHorizontal: 6, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 10},
  versionCopy: {flex: 1, gap: 3},
  hash: {fontSize: 10, fontFamily: 'monospace'},
  versionLabel: {fontSize: 12, lineHeight: 17, fontWeight: '600'},
  description: {fontSize: 10.5, lineHeight: 15},
  currentTag: {fontSize: 10, fontWeight: '700'},
  state: {flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, gap: 12},
  stateText: {fontSize: 12, lineHeight: 18, textAlign: 'center'},
  retry: {minHeight: 36, paddingHorizontal: 18, borderWidth: 1, borderRadius: 8, justifyContent: 'center'},
  empty: {fontSize: 12, textAlign: 'center', paddingVertical: 28},
  footer: {paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, gap: 8},
  selection: {fontSize: 11},
  submit: {minHeight: 42, borderRadius: 9, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6},
  submitText: {fontSize: 12, color: '#fff', fontWeight: '800'},
  disabled: {opacity: 0.45},
});
