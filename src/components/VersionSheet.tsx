import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Check, RefreshCw} from 'lucide-react-native';
import {fetchKarinVersions} from '../services/environmentService';
import {Colors} from '../theme/colors';
import {primaryTextStyle} from '../theme/styles';

type Props = {
  visible: boolean;
  /** 当前容器内实际安装的 node-karin 版本（空串表示未安装）。 */
  installedVersion: string;
  /** 正在切换版本时禁用交互。 */
  busy: boolean;
  colors: Colors;
  onConfirm: (version: string) => void;
  onClose: () => void;
};

type LoadState = 'loading' | 'error' | 'ready';

export default function VersionSheet({visible, installedVersion, busy, colors, onConfirm, onClose}: Props) {
  const [state, setState] = useState<LoadState>('loading');
  const [versions, setVersions] = useState<string[]>([]);
  const [selected, setSelected] = useState('');

  const load = () => {
    setState('loading');
    fetchKarinVersions()
      .then(list => {
        setVersions(list);
        setState('ready');
      })
      .catch(() => setState('error'));
  };

  useEffect(() => {
    if (visible) {
      setSelected(installedVersion);
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const confirmable = state === 'ready' && selected !== '' && !busy;

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.dismiss} onPress={busy ? undefined : onClose} />
        <View style={[styles.sheet, {backgroundColor: colors.surface}]}>
          <Text style={[styles.title, {color: colors.text}]}>选择 Karin 版本</Text>
          <Text style={[styles.body, {color: colors.muted}]}>
            {installedVersion ? `当前安装 v${installedVersion}，切换后立即生效` : '当前未安装 node-karin'}
          </Text>

          {state === 'loading' ? (
            <View style={styles.stateBox}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={[styles.stateText, {color: colors.muted}]}>正在从 npm 获取版本列表…</Text>
            </View>
          ) : state === 'error' ? (
            <View style={styles.stateBox}>
              <Text style={[styles.stateText, {color: colors.muted}]}>版本列表获取失败</Text>
              <Pressable onPress={load} style={[styles.retry, {borderColor: colors.border}]}>
                <RefreshCw size={13} color={colors.accent} />
                <Text style={[styles.retryText, {color: colors.accent}]}>重试</Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView style={[styles.list, {borderColor: colors.border}]} nestedScrollEnabled>
              {versions.map(version => {
                const isSelected = version === selected;
                const isInstalled = version === installedVersion;
                return (
                  <Pressable
                    key={version}
                    onPress={() => setSelected(version)}
                    style={[styles.option, isSelected && {backgroundColor: colors.accentSoft}]}>
                    <Text style={[styles.versionText, {color: isSelected ? colors.accent : colors.text}]}>v{version}</Text>
                    {isInstalled ? (
                      <Text style={[styles.currentTag, {color: colors.muted}]}>当前</Text>
                    ) : null}
                    {isSelected ? <Check size={16} color={colors.accent} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          <View style={styles.actions}>
            <Pressable disabled={busy} onPress={onClose} style={[styles.button, {borderColor: colors.border}]}>
              <Text style={[styles.buttonText, {color: colors.text}]}>取消</Text>
            </Pressable>
            <Pressable
              disabled={!confirmable}
              onPress={() => onConfirm(selected)}
              style={[styles.button, {backgroundColor: colors.accent, borderColor: colors.accent}, !confirmable && styles.buttonDisabled]}>
              {busy ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={primaryTextStyle}>切换</Text>}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.42)', justifyContent: 'flex-end'},
  dismiss: {flex: 1},
  sheet: {borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 28},
  title: {fontSize: 20, fontWeight: '800'},
  body: {fontSize: 13, lineHeight: 19, marginTop: 8},
  stateBox: {height: 148, marginTop: 14, alignItems: 'center', justifyContent: 'center', gap: 10},
  stateText: {fontSize: 12, fontWeight: '600'},
  retry: {flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6},
  retryText: {fontSize: 12, fontWeight: '700'},
  list: {height: 220, borderWidth: 1, borderRadius: 10, marginTop: 14},
  option: {height: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 8},
  versionText: {fontSize: 15, fontWeight: '700', flex: 1},
  currentTag: {fontSize: 11, fontWeight: '600'},
  actions: {flexDirection: 'row', gap: 8, marginTop: 22},
  button: {flex: 1, minHeight: 42, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5},
  buttonDisabled: {opacity: 0.5},
  buttonText: {fontSize: 12, fontWeight: '700'},
});
