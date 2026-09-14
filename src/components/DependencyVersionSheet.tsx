import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {Check, Zap} from 'lucide-react-native';
import {Colors} from '../theme/colors';
import {primaryTextStyle} from '../theme/styles';
import {fetchPackageVersions, hasPackageVersionCache} from '../services/packageVersions';
import {isValidDependencySpec, KarinDependency} from '../services/pluginService';

type Props = {
  visible: boolean;
  dep: KarinDependency | null;
  colors: Colors;
  /** 选中或手填的版本，父组件负责记进待保存列表 */
  onSelect: (spec: string) => void;
  onClose: () => void;
};

type LoadState = 'loading' | 'error' | 'ready';

/**
 * 依赖版本选择：上面是手填框（范围 / dist-tag 也能写），下面是 npm 上的发布版本列表。
 * 版本列表走 packageVersions 的 15 分钟缓存，正常打开不重复请求，需要马上重新拉就点「强制刷新」。
 */
export default function DependencyVersionSheet({visible, dep, colors, onSelect, onClose}: Props) {
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

  const load = useCallback((target: string, force: boolean) => {
    setState('loading');
    setError('');
    const cached = !force && hasPackageVersionCache(target);
    fetchPackageVersions(target, {force})
      .then(list => {
        setVersions(list);
        setFromCache(cached);
        setState('ready');
      })
      .catch(caught => {
        setVersions([]);
        setError(caught instanceof Error ? caught.message : String(caught));
        setState('error');
      });
  }, []);

  useEffect(() => {
    if (!visible || !dep) return;
    setInput(dep.spec);
    setInputError('');
    load(dep.name, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, dep?.name]);

  /** Android 15+ 强制 edge-to-edge，Modal 里的 adjustResize 不缩窗口，按实测底边把面板顶到输入法上方 */
  useEffect(() => {
    if (!visible) {
      setKeyboardInset(0);
      return;
    }
    const show = Keyboard.addListener('keyboardDidShow', event => {
      const keyboardHeight = event.endCoordinates.height + insets.bottom;
      sheetRef.current?.measureInWindow((_x, y, _width, height) => {
        const bottomGap = Dimensions.get('screen').height - (y + height);
        setKeyboardInset(Math.max(0, Math.round(keyboardHeight - bottomGap)));
      });
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardInset(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [insets.bottom, visible]);

  const submitInput = () => {
    const next = input.trim();
    if (!next) {
      setInputError('请填写版本号');
      return;
    }
    if (!isValidDependencySpec(next)) {
      setInputError('只支持版本号、^ / ~ 范围或 dist-tag；git、link、workspace 地址请用卸载后重装');
      return;
    }
    if (next === dep?.spec) {
      setInputError('版本没有变化');
      return;
    }
    onSelect(next);
  };

  const pick = (version: string) => {
    if (version === dep?.spec) {
      onClose();
      return;
    }
    onSelect(version);
  };

  return (
    <Modal transparent visible={visible} animationType='slide' onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.dismiss} onPress={onClose} />
        <View
          ref={sheetRef}
          style={[styles.sheet, {backgroundColor: colors.surface, paddingBottom: insets.bottom + keyboardInset}]}>
          <View style={styles.head}>
            <View style={styles.headCopy}>
              <Text numberOfLines={1} style={[styles.title, {color: colors.text}]}>
                {name || '选择版本'}
              </Text>
              <Text numberOfLines={1} style={[styles.subtitle, {color: colors.muted}]}>
                {`当前 ${dep?.spec || '未声明'}${dep?.dev ? ' · devDependencies' : ''}`}
              </Text>
            </View>
            <Pressable accessibilityLabel='关闭' onPress={onClose} style={styles.closeButton}>
              <Text style={[styles.closeText, {color: colors.muted}]}>关闭</Text>
            </Pressable>
          </View>

          <View style={styles.inputRow}>
            <TextInput
              autoCapitalize='none'
              autoCorrect={false}
              onChangeText={text => {
                setInput(text);
                setInputError('');
              }}
              onSubmitEditing={submitInput}
              placeholder='1.2.3 或 ^1.2.3'
              placeholderTextColor={colors.muted}
              returnKeyType='done'
              style={[
                styles.input,
                {
                  backgroundColor: colors.neutralSoft,
                  borderColor: inputError ? colors.danger : colors.border,
                  color: colors.text,
                },
              ]}
              value={input}
            />
            <Pressable
              accessibilityRole='button'
              disabled={!input.trim()}
              onPress={submitInput}
              style={[styles.applyButton, {backgroundColor: colors.accent}, !input.trim() && styles.disabled]}>
              <Text style={primaryTextStyle}>应用</Text>
            </Pressable>
          </View>
          <Text style={[styles.inputHint, {color: inputError ? colors.danger : colors.muted}]}>
            {inputError || '也可以直接手填版本范围或 dist-tag，保存前不会改动容器。'}
          </Text>

          {state === 'loading' ? (
            <View style={styles.state}>
              <ActivityIndicator color={colors.accent} size='small' />
              <Text style={[styles.stateText, {color: colors.muted}]}>正在获取 npm 版本列表…</Text>
            </View>
          ) : state === 'error' ? (
            <View style={styles.state}>
              <Text style={[styles.stateText, {color: colors.danger}]}>{error}</Text>
              <Pressable onPress={() => load(name, true)} style={[styles.retry, {borderColor: colors.border}]}>
                <Text style={[styles.retryText, {color: colors.accent}]}>强制刷新</Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps='handled' style={styles.listScroll}>
              {versions.map(version => {
                const active = version === dep?.spec;
                return (
                  <Pressable
                    key={version}
                    onPress={() => pick(version)}
                    style={[styles.versionRow, {borderBottomColor: colors.border}]}>
                    <Text style={[styles.versionText, {color: active ? colors.accent : colors.text}]}>{version}</Text>
                    {version.includes('-') ? (
                      <View style={[styles.tag, {backgroundColor: colors.neutralSoft}]}>
                        <Text style={[styles.tagText, {color: colors.muted}]}>pre</Text>
                      </View>
                    ) : null}
                    {active ? <Check size={16} color={colors.accent} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          <View style={[styles.foot, {borderTopColor: colors.border}]}>
            <Text numberOfLines={1} style={[styles.footText, {color: colors.muted}]}>
              {state === 'ready' && fromCache ? '版本列表来自缓存 · 15 分钟内不重复请求' : '版本列表每 15 分钟最多请求一次'}
            </Text>
            <Pressable
              accessibilityLabel='强制刷新版本列表'
              disabled={state === 'loading'}
              onPress={() => load(name, true)}
              style={styles.forceButton}>
              <Zap color={colors.accent} size={13} />
              <Text style={[styles.forceText, {color: colors.accent}]}>强制刷新</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.45)'},
  dismiss: {flex: 1},
  sheet: {maxHeight: '78%', borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 14},
  head: {flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 16},
  headCopy: {flex: 1, gap: 3},
  title: {fontFamily: 'monospace', fontSize: 14, fontWeight: '700'},
  subtitle: {fontSize: 11, fontWeight: '600'},
  closeButton: {minHeight: 28, justifyContent: 'center', paddingHorizontal: 4},
  closeText: {fontSize: 12, fontWeight: '700'},
  inputRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12},
  input: {flex: 1, minHeight: 38, borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, fontSize: 13, fontFamily: 'monospace'},
  applyButton: {minWidth: 58, minHeight: 38, borderRadius: 9, alignItems: 'center', justifyContent: 'center'},
  disabled: {opacity: 0.45},
  inputHint: {fontSize: 11, lineHeight: 16, paddingHorizontal: 16, paddingTop: 6},
  state: {paddingVertical: 28, alignItems: 'center', gap: 12},
  stateText: {fontSize: 12, textAlign: 'center', paddingHorizontal: 20},
  retry: {borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6},
  retryText: {fontSize: 12, fontWeight: '700'},
  /** 面板有 maxHeight，列表要能收缩才能滚动而不是把面板撑破 */
  listScroll: {flexShrink: 1},
  list: {paddingHorizontal: 16, paddingTop: 8},
  versionRow: {minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth},
  versionText: {flex: 1, fontFamily: 'monospace', fontSize: 12.5},
  tag: {borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1},
  tagText: {fontSize: 9, fontWeight: '700'},
  foot: {flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12},
  footText: {flex: 1, fontSize: 10.5},
  forceButton: {flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 28},
  forceText: {fontSize: 11, fontWeight: '700'},
});