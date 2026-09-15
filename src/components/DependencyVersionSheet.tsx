import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Dimensions, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {Check, Download, Trash2, X, Zap} from 'lucide-react-native';
import {Colors} from '../theme/colors';
import {primaryTextStyle} from '../theme/styles';
import {clearPackageVersionCache, fetchPackageVersions, hasPackageVersionCache} from '../services/packageVersions';
import {KarinDependency} from '../services/pluginService';

type SheetDependency = KarinDependency & {installedVersion?: string; latestVersion?: string};

type Props = {
  visible: boolean;
  dep: SheetDependency | null;
  colors: Colors;
  onSelect: (spec: string) => void;
  onUpdateLatest?: () => void;
  onUninstall?: () => void;
  onClearCache?: () => void;
  onClose: () => void;
};

type LoadState = 'loading' | 'error' | 'ready';

/** 依赖操作底部菜单：点击版本只填入自定义输入，应用后由父页面立即安装。 */
export default function DependencyVersionSheet({visible, dep, colors, onSelect, onUpdateLatest, onUninstall, onClearCache, onClose}: Props) {
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<React.ComponentRef<typeof View>>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [versions, setVersions] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [fromCache, setFromCache] = useState(false);
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState('');
  const [keyboardInset, setKeyboardInset] = useState(0);
  const name = dep?.name ?? '';
  const installedVersion = dep?.installedVersion || '未知';
  const latestVersion = dep?.latestVersion || versions.find(version => !version.includes('-')) || versions[0] || '未知';
  const canUninstall = Boolean(dep && !dep.core && onUninstall);
  const alreadyLatest = installedVersion !== '未知' && latestVersion !== '未知' && installedVersion === latestVersion;

  const load = useCallback((target: string, force: boolean) => {
    if (!target) return;
    setState('loading'); setError('');
    const cached = !force && hasPackageVersionCache(target);
    fetchPackageVersions(target, {force}).then(list => {
      setVersions(list); setFromCache(cached); setState('ready');
    }).catch(caught => {
      setVersions([]); setError(caught instanceof Error ? caught.message : String(caught)); setState('error');
    });
  }, []);

  useEffect(() => {
    if (!visible || !dep) return;
    setInput(dep.spec || ''); setInputError(''); load(dep.name, false);
  }, [visible, dep, load]);

  useEffect(() => {
    if (!visible) { setKeyboardInset(0); return; }
    const show = Keyboard.addListener('keyboardDidShow', event => {
      const keyboardHeight = event.endCoordinates.height + insets.bottom;
      sheetRef.current?.measureInWindow((_x, y, _width, height) => {
        const bottomGap = Dimensions.get('screen').height - (y + height);
        setKeyboardInset(Math.max(0, Math.round(keyboardHeight - bottomGap)));
      });
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardInset(0));
    return () => { show.remove(); hide.remove(); };
  }, [insets.bottom, visible]);

  const submitInput = () => {
    const next = input.trim();
    if (!next) { setInputError('请填写版本号'); return; }
    if (next === dep?.spec) { setInputError('版本没有变化'); return; }
    onSelect(next);
  };
  const pick = (version: string) => {
    setInput(version);
    setInputError('');
  };
  const clearCache = () => { onClearCache?.(); if (!onClearCache) clearPackageVersionCache(name); load(name, true); };

  return <Modal transparent visible={visible} animationType='slide' onRequestClose={onClose}>
    <View style={styles.backdrop}>
      <Pressable style={styles.dismiss} onPress={onClose} />
      <View ref={sheetRef} style={[styles.sheet, {backgroundColor: colors.surface, paddingBottom: insets.bottom + keyboardInset}]}>
        <View style={styles.grabber} />
        <View style={styles.head}>
          <View style={styles.headCopy}><Text numberOfLines={1} style={[styles.title, {color: colors.text}]}>{name || '依赖操作'}</Text><Text style={[styles.subtitle, {color: colors.muted}]}>依赖信息与版本操作</Text></View>
          <Pressable accessibilityLabel='关闭' onPress={onClose} style={styles.closeButton}><X color={colors.muted} size={18} /></Pressable>
        </View>
        <View style={[styles.infoCard, {backgroundColor: colors.neutralSoft, borderColor: colors.border}]}>
          <InfoRow label='package.json' value={dep?.spec || '未声明'} colors={colors} />
          <InfoRow label='当前安装' value={installedVersion} colors={colors} />
          <InfoRow label='最新版本' value={latestVersion} colors={colors} accent />
        </View>
        <View style={styles.actions}>
          <Pressable accessibilityLabel={alreadyLatest ? '已是最新版本' : '更新'} disabled={!dep || alreadyLatest} onPress={() => (onUpdateLatest ? onUpdateLatest() : onSelect('latest'))} style={[styles.actionButton, {borderColor: colors.accent, backgroundColor: colors.accentSoft}, (!dep || alreadyLatest) && styles.disabled]}><Download color={alreadyLatest ? colors.muted : colors.accent} size={15} /><Text style={[styles.actionText, {color: alreadyLatest ? colors.muted : colors.accent}]}>更新</Text></Pressable>
          <Pressable disabled={!canUninstall} onPress={onUninstall} style={[styles.actionButton, {borderColor: colors.danger, backgroundColor: colors.surface}, !canUninstall && styles.disabled]}><Trash2 color={colors.danger} size={15} /><Text style={[styles.actionText, {color: colors.danger}]}>卸载</Text></Pressable>
        </View>
        <View style={styles.inputRow}>
          <TextInput autoCapitalize='none' autoCorrect={false} onChangeText={text => {setInput(text); setInputError('');}} onSubmitEditing={submitInput} placeholder='自定义版本 / 范围 / dist-tag' placeholderTextColor={colors.muted} returnKeyType='done' style={[styles.input, {backgroundColor: colors.neutralSoft, borderColor: inputError ? colors.danger : colors.border, color: colors.text}]} value={input} />
          <Pressable disabled={!input.trim()} onPress={submitInput} style={[styles.applyButton, {backgroundColor: colors.accent}, !input.trim() && styles.disabled]}><Text style={primaryTextStyle}>应用更改</Text></Pressable>
        </View>
        <Text style={[styles.inputHint, {color: inputError ? colors.danger : colors.muted}]}>{inputError || '支持普通版本、范围、dist-tag 或 pkg.pr.new 地址。点击应用更改后立即安装。'}</Text>
        <View style={styles.versionHeader}><Text style={[styles.sectionTitle, {color: colors.text}]}>可用版本</Text><Pressable accessibilityLabel='清除版本缓存并刷新' disabled={state === 'loading'} onPress={clearCache} style={styles.forceButton}><Zap color={colors.accent} size={13} /><Text style={[styles.forceText, {color: colors.accent}]}>清除缓存</Text></Pressable></View>
        {state === 'loading' ? <View style={styles.state}><ActivityIndicator color={colors.accent} size='small' /><Text style={[styles.stateText, {color: colors.muted}]}>正在获取版本列表…</Text></View> : state === 'error' ? <View style={styles.state}><Text style={[styles.stateText, {color: colors.danger}]}>{error}</Text><Pressable onPress={() => load(name, true)} style={[styles.retry, {borderColor: colors.border}]}><Text style={[styles.retryText, {color: colors.accent}]}>重试</Text></Pressable></View> : <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps='handled' style={styles.listScroll}>{versions.map(version => {const active = version === dep?.spec; return <Pressable key={version} onPress={() => pick(version)} style={[styles.versionRow, {borderBottomColor: colors.border}]}><Text style={[styles.versionText, {color: active ? colors.accent : colors.text}]}>{version}</Text>{active ? <Check size={16} color={colors.accent} /> : null}</Pressable>;})}</ScrollView>}
        <Text style={[styles.cacheHint, {color: colors.muted}]}>{fromCache ? '版本列表来自缓存 · 1 小时内有效' : '版本列表缓存 1 小时有效'}</Text>
      </View>
    </View>
  </Modal>;
}

function InfoRow({label, value, colors, accent}: {label: string; value: string; colors: Colors; accent?: boolean}) { return <View style={styles.infoRow}><Text style={[styles.infoLabel, {color: colors.muted}]}>{label}</Text><Text numberOfLines={1} style={[styles.infoValue, {color: accent ? colors.accent : colors.text}]}>{value}</Text></View>; }

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.45)'}, dismiss: {flex: 1}, sheet: {maxHeight: '88%', borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 9}, grabber: {width: 34, height: 4, borderRadius: 3, backgroundColor: '#B7A3AA', alignSelf: 'center', marginBottom: 8}, head: {flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 16}, headCopy: {flex: 1, gap: 3}, title: {fontFamily: 'monospace', fontSize: 14, fontWeight: '700'}, subtitle: {fontSize: 11, fontWeight: '600'}, closeButton: {width: 30, height: 30, alignItems: 'center', justifyContent: 'center'}, infoCard: {marginHorizontal: 16, marginTop: 12, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, gap: 5}, infoRow: {flexDirection: 'row', alignItems: 'center', minHeight: 20}, infoLabel: {width: 90, fontSize: 10.5}, infoValue: {flex: 1, fontFamily: 'monospace', fontSize: 11.5, fontWeight: '700', textAlign: 'right'}, actions: {flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 10}, actionButton: {flex: 1, minHeight: 38, borderWidth: 1, borderRadius: 9, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6}, actionText: {fontSize: 11.5, fontWeight: '800'}, inputRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 10}, input: {flex: 1, minHeight: 38, borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, fontSize: 12, fontFamily: 'monospace'}, applyButton: {minWidth: 76, minHeight: 38, borderRadius: 9, alignItems: 'center', justifyContent: 'center'}, inputHint: {fontSize: 10.5, lineHeight: 15, paddingHorizontal: 16, paddingTop: 5}, versionHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 10}, sectionTitle: {fontSize: 11.5, fontWeight: '800'}, forceButton: {flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 28}, forceText: {fontSize: 10.5, fontWeight: '700'}, listScroll: {flexShrink: 1, marginTop: 3}, list: {paddingHorizontal: 16, paddingBottom: 3}, versionRow: {minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth}, versionText: {flex: 1, fontFamily: 'monospace', fontSize: 12}, state: {paddingVertical: 20, alignItems: 'center', gap: 10}, stateText: {fontSize: 11.5, textAlign: 'center', paddingHorizontal: 20}, retry: {borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6}, retryText: {fontSize: 11.5, fontWeight: '700'}, cacheHint: {fontSize: 10, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 7}, disabled: {opacity: 0.45},
});
