import React, {useEffect, useState} from 'react';
import {ActivityIndicator, BackHandler, Image, Linking, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {ChevronLeft, ChevronRight} from 'lucide-react-native';
import karinMark from '../assets/karin-mark.png';
import {BOTTOM_NAV_HEIGHT} from '../components/BottomNav';
import Toast, {TOAST_BOTTOM_OFFSET} from '../components/Toast';
import UpdateDialogs from '../components/UpdateDialogs';
import UpdateTaskFab from '../components/UpdateTaskFab';
import UpdateTaskSheet from '../components/UpdateTaskSheet';
import {useToast} from '../hooks/useToast';
import {useUpdateFlow} from '../hooks/useUpdateFlow';
import {getUpdateState} from '../services/updateService';
import {Colors} from '../theme/colors';

const GITHUB_URL = 'https://github.com/KarinJS/KarinApp';
const QQ_GROUP_NUMBER = '850541480';
/** QQ 群名片深链：装了 QQ 会直接打开群资料。RN 在 Android 11+ 的 canOpenURL 受包可见性限制，所以直接开、失败再退。 */
const QQ_GROUP_SCHEME = `mqqapi://card/show_pslcard?src_type=internal&version=1&uin=${QQ_GROUP_NUMBER}&card_type=group&source=qrcode`;
/** 没装 QQ 或深链失败时的浏览器兜底，用群官方邀请链接（换群时替换这里）。 */
const QQ_GROUP_WEB_URL = 'https://qm.qq.com/q/so3xck79sc';
/** 悬浮提示比普通操作提示多留一会儿，方便看清版本号 */
const NOTICE_DURATION_MS = 5000;
/** 关于页容器不含底部导航，减掉导航高度才能和首页的悬浮提示落在同一高度 */
const TOAST_BOTTOM = TOAST_BOTTOM_OFFSET - BOTTOM_NAV_HEIGHT;

type Props = {
  colors: Colors;
  /** 已安装的 node-karin 版本，空串表示未安装 */
  karinVersion: string;
  onBack: () => void;
};

/** 顺次尝试多个链接，返回是否有一个打开成功（取消选择的 App 也算成功）。 */
const openFirstAvailable = async (urls: string[]) => {
  for (const url of urls) {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      // 没有应用能处理这个 scheme，试下一个
    }
  }
  return false;
};

/** 关于页：Logo、版本号、检查更新（悬浮提示「已是最新」）、GitHub 与 QQ 群入口。 */
export default function AboutScreen({colors, karinVersion, onBack}: Props) {
  const {notice, showNotice} = useToast();
  const flow = useUpdateFlow();
  const {update, busy} = flow;
  const [taskOpen, setTaskOpen] = useState(false);

  /** 下载完成要弹「是否安装」，先把下载任务弹窗收掉，免得两个 Modal 叠在一起 */
  useEffect(() => {
    if (taskOpen && update.phase === 'ready') setTaskOpen(false);
  }, [taskOpen, update.phase]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);

  const handleGithub = async () => {
    if (!(await openFirstAvailable([GITHUB_URL]))) showNotice('无法打开 GitHub，请确认已安装浏览器', NOTICE_DURATION_MS);
  };

  const handleQqGroup = async () => {
    if (!(await openFirstAvailable([QQ_GROUP_SCHEME, QQ_GROUP_WEB_URL]))) {
      showNotice(`无法打开 QQ 群 ${QQ_GROUP_NUMBER}，请在 QQ 里手动搜索`, NOTICE_DURATION_MS);
    }
  };

  const handleCheckUpdate = async () => {
    const phase = await flow.check();
    if (phase === 'idle') showNotice('当前已是最新版本', NOTICE_DURATION_MS);
    else if (phase === 'error') showNotice(getUpdateState().message || '检查更新失败', NOTICE_DURATION_MS);
  };

  const statusColor = update.phase === 'error' ? colors.danger : colors.muted;
  /** 下载中断会退回 available（带半截包），和 error 一样算失败；只是检查失败时没有下载任务 */
  const failed = update.task && (update.phase === 'error' || (update.phase === 'available' && !!update.partial));
  /** 只在有进行中/失败的下载任务时才出现悬浮按钮 */
  const showTaskFab = update.task && (update.phase === 'downloading' || failed);

  return (
    <View style={styles.container}>
      <View style={[styles.header, {borderBottomColor: colors.border}]}>
        <Pressable onPress={onBack} style={styles.headerButton} accessibilityLabel="返回">
          <ChevronLeft size={20} color={colors.text} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={[styles.headerTitle, {color: colors.text}]}>关于</Text>
          <Text numberOfLines={1} style={[styles.headerHint, {color: colors.muted}]}>应用信息与反馈渠道</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.brand, {backgroundColor: colors.accentSoft, borderColor: colors.border}]}>
          <Image source={karinMark} style={styles.logo} resizeMode="contain" />
        </View>
        <Text style={[styles.name, {color: colors.text}]}>Karin</Text>
        <Text style={[styles.version, {color: colors.text}]}>v{update.appVersion || '未知'}</Text>
        <Text style={[styles.subVersion, {color: colors.muted}]}>
          {karinVersion ? `node-karin v${karinVersion}` : 'node-karin 未安装'}
        </Text>

        <View style={[styles.list, {backgroundColor: colors.surface, borderColor: colors.border}]}>
          <Pressable onPress={handleCheckUpdate} style={[styles.row, styles.rowDivider, {borderBottomColor: colors.border}]}>
            <View style={styles.copy}>
              <Text style={[styles.label, {color: colors.text}]}>检查更新</Text>
              <Text style={[styles.value, {color: statusColor}]}>{flow.status}</Text>
            </View>
            {busy ? <ActivityIndicator color={colors.accent} size="small" /> : <ChevronRight size={18} color={colors.muted} />}
          </Pressable>
          <Pressable onPress={handleGithub} style={[styles.row, styles.rowDivider, {borderBottomColor: colors.border}]}>
            <View style={styles.copy}>
              <Text style={[styles.label, {color: colors.text}]}>GitHub</Text>
              <Text style={[styles.value, {color: colors.muted}]}>KarinJS/KarinApp，选择浏览器或 GitHub 打开</Text>
            </View>
            <ChevronRight size={18} color={colors.muted} />
          </Pressable>
          <Pressable onPress={handleQqGroup} style={styles.row}>
            <View style={styles.copy}>
              <Text style={[styles.label, {color: colors.text}]}>加入 QQ 群聊</Text>
              <Text style={[styles.value, {color: colors.muted}]}>群号 {QQ_GROUP_NUMBER}，优先用 QQ 打开</Text>
            </View>
            <ChevronRight size={18} color={colors.muted} />
          </Pressable>
        </View>

      </ScrollView>

      {showTaskFab ? (
        <UpdateTaskFab
          colors={colors}
          progress={update.progress}
          failed={failed}
          onPress={() => setTaskOpen(true)}
        />
      ) : null}
      {notice ? <Toast message={notice} colors={colors} bottomOffset={TOAST_BOTTOM} /> : null}
      <UpdateDialogs colors={colors} flow={flow} />
      <UpdateTaskSheet
        colors={colors}
        update={update}
        failed={failed}
        visible={taskOpen}
        onRetry={flow.retryDownload}
        onClose={() => setTaskOpen(false)}
      />
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
  content: {paddingHorizontal: 16, paddingTop: 20, paddingBottom: 28, alignItems: 'center'},
  brand: {width: 96, height: 96, borderRadius: 24, borderWidth: 1, alignItems: 'center', justifyContent: 'center'},
  logo: {width: 64, height: 64},
  name: {fontSize: 20, fontWeight: '800', marginTop: 14},
  version: {fontSize: 14, fontWeight: '700', marginTop: 4},
  subVersion: {fontSize: 11, fontWeight: '600', marginTop: 3},
  list: {width: '100%', borderWidth: 1, borderRadius: 13, overflow: 'hidden', marginTop: 22},
  row: {minHeight: 62, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  rowDivider: {borderBottomWidth: StyleSheet.hairlineWidth},
  copy: {flex: 1, gap: 4, paddingRight: 10},
  label: {fontSize: 14, fontWeight: '700'},
  value: {fontSize: 11, fontWeight: '600'},
});
