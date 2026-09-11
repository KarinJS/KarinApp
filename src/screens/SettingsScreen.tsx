import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Check, ChevronRight} from 'lucide-react-native';
import AboutScreen from './AboutScreen';
import {Colors} from '../theme/colors';
import {executeAndCollect} from '../services/prootController';
import {isValidGithubProxy, loadAppSettings, normalizeGithubProxy, saveGithubProxy} from '../services/appSettings';

const REGISTRIES = [
  {label: '官方源', url: 'https://registry.npmjs.org'},
  {label: '淘宝源', url: 'https://registry.npmmirror.com'},
  {label: '腾讯源', url: 'https://mirrors.cloud.tencent.com/npm/'},
] as const;

/**
 * npm 读写回来的 registry 可能带结尾 /（官方源尤其常见：设置时没有，安装完再读就多了个 /），
 * 直接字符串比较会把官方源误判成自定义源，所以统一去空格、忽略大小写、去掉结尾斜杠后再比。
 */
const normalizeRegistry = (value: string) => value.trim().toLowerCase().replace(/\/+$/, '');

type Props = {
  colors: Colors;
  version: string;
  onOpen: () => void;
  onResetProject: () => void;
  onResetContainer: () => void;
};

export default function SettingsScreen({colors, version, onOpen, onResetProject, onResetContainer}: Props) {
  const [registry, setRegistry] = useState<string>(REGISTRIES[0].url);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [proxyInput, setProxyInput] = useState('');
  const [savedProxy, setSavedProxy] = useState('');
  const [proxySaving, setProxySaving] = useState(false);
  const [proxyError, setProxyError] = useState('');
  const [aboutOpen, setAboutOpen] = useState(false);

  const readRegistry = useCallback(() => {
    executeAndCollect('npm config get registry')
      .then(value => {
        const next = value.trim();
        if (next && next !== 'undefined' && next !== 'null') setRegistry(next);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    readRegistry();
  }, [readRegistry]);

  useEffect(() => {
    loadAppSettings()
      .then(settings => {
        setProxyInput(settings.githubProxy);
        setSavedProxy(settings.githubProxy);
      })
      .catch(() => {});
  }, []);

  const normalizedProxy = normalizeGithubProxy(proxyInput);
  const proxyValid = isValidGithubProxy(proxyInput);
  const proxyDirty = proxyValid && normalizedProxy !== savedProxy;

  const saveProxy = () => {
    if (!proxyValid || proxySaving) return;
    setProxyError('');
    setProxySaving(true);
    saveGithubProxy(proxyInput)
      .then(value => {
        setProxyInput(value);
        setSavedProxy(value);
      })
      .catch(() => setProxyError('保存失败，请确认容器已启动'))
      .finally(() => setProxySaving(false));
  };

  const selectRegistry = (url: string) => {
    setRegistry(url);
    setRegistryOpen(false);
    /** 设置完再读一次，展示 npm 真正生效的值（可能被补上结尾 /） */
    executeAndCollect(`npm config set registry ${url}`).then(readRegistry).catch(() => {});
  };

  const currentRegistry = normalizeRegistry(registry);
  const registryLabel = !currentRegistry
    ? '未设置'
    : REGISTRIES.find(item => normalizeRegistry(item.url) === currentRegistry)?.label ?? '自定义源';

  if (aboutOpen) {
    return <AboutScreen colors={colors} karinVersion={version} onBack={() => setAboutOpen(false)} />;
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[styles.intro, {color: colors.muted}]}>统一管理容器运行环境与 Karin 版本</Text>
      <View style={[styles.list, {backgroundColor: colors.surface, borderColor: colors.border}]}>
        <Pressable onPress={() => setAboutOpen(true)} style={styles.row}>
          <View style={styles.copy}>
            <Text style={[styles.label, {color: colors.text}]}>关于 Karin App</Text>
            <Text style={[styles.value, {color: colors.muted}]}>版本信息、检查更新、GitHub 与 QQ 群</Text>
          </View>
          <ChevronRight size={18} color={colors.muted} />
        </Pressable>
      </View>

      <View style={[styles.list, styles.listGap, {backgroundColor: colors.surface, borderColor: colors.border}]}>
        <Pressable onPress={onOpen} style={styles.row}>
          <View style={styles.copy}>
            <Text style={[styles.label, {color: colors.text}]}>Karin 版本</Text>
            <Text style={[styles.value, {color: colors.muted}]}>{version ? `v${version}` : '未安装'}</Text>
          </View>
          <ChevronRight size={18} color={colors.muted} />
        </Pressable>
      </View>

      <Text style={[styles.sectionTitle, {color: colors.muted}]}>NPM 源</Text>
      <View style={[styles.list, {backgroundColor: colors.surface, borderColor: colors.border}]}>
        <Pressable onPress={() => setRegistryOpen(open => !open)} style={styles.row}>
          <View style={styles.copy}><Text style={[styles.label, {color: colors.text}]}>{registryLabel}</Text><Text numberOfLines={1} style={[styles.value, {color: colors.muted}]}>{registry}</Text></View>
          <ChevronRight size={18} color={colors.muted} style={registryOpen ? {transform: [{rotate: '90deg'}]} : undefined} />
        </Pressable>
        {registryOpen ? REGISTRIES.map((item, index) => (
          <Pressable key={item.url} onPress={() => selectRegistry(item.url)} style={[styles.option, index < REGISTRIES.length - 1 && styles.rowDivider, {borderBottomColor: colors.border}]}>
            <Text style={[styles.optionText, {color: colors.text}]}>{item.label}</Text>
            {normalizeRegistry(item.url) === currentRegistry ? <Check size={17} color={colors.accent} /> : null}
          </Pressable>
        )) : null}
      </View>

      <Text style={[styles.sectionTitle, {color: colors.muted}]}>GitHub 加速</Text>
      <View style={[styles.list, {backgroundColor: colors.surface, borderColor: colors.border}]}>
        <View style={[styles.block, styles.rowDivider, {borderBottomColor: colors.border}]}>
          <Text style={[styles.label, {color: colors.text}]}>加速前缀</Text>
          <TextInput
            autoCapitalize='none'
            autoCorrect={false}
            keyboardType='url'
            onChangeText={setProxyInput}
            placeholder='https://gh-proxy.com/'
            placeholderTextColor={colors.muted}
            style={[
              styles.input,
              {
                backgroundColor: colors.neutralSoft,
                borderColor: proxyValid ? colors.border : colors.danger,
                color: colors.text,
              },
            ]}
            value={proxyInput}
          />
          <Text style={[styles.value, {color: proxyValid ? colors.muted : colors.danger}]}>
            {!proxyValid
              ? '格式不正确，需要 http(s)://域名'
              : normalizedProxy
                ? `实际下载：${normalizedProxy}https://github.com/...`
                : '留空表示直连 GitHub'}
          </Text>
        </View>
        <Pressable disabled={!proxyDirty || proxySaving} onPress={saveProxy} style={styles.row}>
          <View style={styles.copy}>
            <Text style={[styles.label, {color: proxyDirty ? colors.accent : colors.muted}]}>
              {proxySaving ? '正在保存…' : proxyDirty ? '保存加速设置' : '加速设置已保存'}
            </Text>
            <Text style={[styles.value, {color: proxyError ? colors.danger : colors.muted}]}>
              {proxyError || '用于 git clone、app 插件文件与 README 图片下载'}
            </Text>
          </View>
          {proxySaving ? (
            <ActivityIndicator color={colors.accent} size='small' />
          ) : proxyDirty ? (
            <Check color={colors.accent} size={17} />
          ) : null}
        </Pressable>
      </View>

      <Text style={[styles.sectionTitle, {color: colors.muted}]}>危险操作</Text>
      <View style={[styles.list, {backgroundColor: colors.surface, borderColor: colors.border}]}>
        <Pressable onPress={onResetProject} style={[styles.row, styles.rowDivider, {borderBottomColor: colors.border}]}>
          <View style={styles.copy}>
            <Text style={[styles.label, {color: colors.danger}]}>重置 Karin 项目</Text>
            <Text style={[styles.value, {color: colors.muted}]}>清空 /root/karin 后重新安装并初始化</Text>
          </View>
          <ChevronRight size={18} color={colors.muted} />
        </Pressable>
        <Pressable onPress={onResetContainer} style={styles.row}>
          <View style={styles.copy}>
            <Text style={[styles.label, {color: colors.danger}]}>重置容器</Text>
            <Text style={[styles.value, {color: colors.muted}]}>删除 Debian 容器并重新解包安装</Text>
          </View>
          <ChevronRight size={18} color={colors.muted} />
        </Pressable>
      </View>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {paddingHorizontal: 16, paddingTop: 4, paddingBottom: 28},
  intro: {fontSize: 12, lineHeight: 18, marginBottom: 12},
  sectionTitle: {fontSize: 12, fontWeight: '700', marginTop: 20, marginBottom: 8},
  list: {borderWidth: 1, borderRadius: 13, overflow: 'hidden'},
  /** 相邻两个没有小标题的分组之间留出间距 */
  listGap: {marginTop: 12},
  block: {paddingHorizontal: 15, paddingVertical: 12, gap: 8},
  input: {minHeight: 38, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, fontSize: 13, fontFamily: 'monospace'},
  row: {minHeight: 62, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  rowDivider: {borderBottomWidth: StyleSheet.hairlineWidth},
  option: {minHeight: 44, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  optionText: {fontSize: 13, fontWeight: '600'},
  copy: {gap: 4},
  label: {fontSize: 14, fontWeight: '700'},
  value: {fontSize: 11, fontWeight: '600'},
});
