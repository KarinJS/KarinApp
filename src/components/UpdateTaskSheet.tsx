import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {ChevronDown, ChevronUp, X} from 'lucide-react-native';
import LogConsole from './LogConsole';
import {Colors} from '../theme/colors';
import {formatSize} from '../services/updateService';
import type {UpdateState} from '../services/updateService';

type Props = {
  visible: boolean;
  colors: Colors;
  update: UpdateState;
  /** 下载失败或中断：进度条转红、状态显示错误信息，并出现默认折叠的错误日志 */
  failed?: boolean;
  onClose: () => void;
};

/** 下载任务弹窗：显示进度条与状态，只有失败/中断时才出现错误日志，且默认折叠。 */
export default function UpdateTaskSheet({visible, colors, update, failed, onClose}: Props) {
  const [logOpen, setLogOpen] = useState(false);

  /** 每次重新打开都把日志收回去 */
  useEffect(() => {
    if (visible) setLogOpen(false);
  }, [visible]);

  const total = update.partial?.total || update.release?.size || 0;
  const ratio = update.progress >= 0 ? Math.min(1, update.progress) : -1;
  const percent = ratio >= 0 ? Math.floor(ratio * 100) : -1;
  const received = update.partial?.received || (ratio > 0 && total > 0 ? ratio * total : 0);
  const receivedText = received > 0 ? formatSize(received) : '0 KB';
  const sizeText = total > 0 ? `${receivedText} / ${formatSize(total)}` : received > 0 ? `已下载 ${receivedText}` : '大小未知';

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, {backgroundColor: colors.surface}]}>
          <View style={styles.header}>
            <Text style={[styles.title, {color: colors.text}]}>下载任务</Text>
            <Pressable onPress={onClose} style={styles.close} accessibilityLabel="关闭">
              <X size={18} color={colors.muted} />
            </Pressable>
          </View>
          <Text style={[styles.subtitle, {color: colors.muted}]}>
            {update.release ? `Karin v${update.release.version}` : 'Karin 安装包'}
          </Text>

          <View style={[styles.track, {backgroundColor: colors.neutralSoft}]}>
            <View
              style={[
                styles.fill,
                {backgroundColor: failed ? colors.danger : colors.accent, width: `${Math.max(2, percent)}%`},
              ]}
            />
          </View>
          <View style={styles.metaRow}>
            <Text numberOfLines={1} style={[styles.meta, {color: colors.muted}]}>{sizeText}</Text>
            <Text style={[styles.percent, {color: failed ? colors.danger : colors.text}]}>
              {percent >= 0 ? `${percent}%` : '下载中'}
            </Text>
          </View>

          <View style={styles.statusRow}>
            {update.phase === 'downloading' ? <ActivityIndicator size="small" color={colors.accent} /> : null}
            <Text numberOfLines={3} style={[styles.status, {color: failed ? colors.danger : colors.muted}]}>
              {update.message || '等待下载…'}
            </Text>
          </View>

          {failed ? (
            <View style={[styles.logWrap, {borderColor: colors.border}]}>
              <Pressable onPress={() => setLogOpen(open => !open)} style={styles.logHeader}>
                <Text style={[styles.logTitle, {color: colors.muted}]}>错误日志</Text>
                {logOpen ? <ChevronUp size={16} color={colors.muted} /> : <ChevronDown size={16} color={colors.muted} />}
              </Pressable>
              {logOpen ? <LogConsole colors={colors} logs={update.logs} maxHeight={160} /> : null}
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.46)', alignItems: 'center', justifyContent: 'center', padding: 24},
  sheet: {width: '100%', borderRadius: 16, padding: 20},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  title: {fontSize: 18, fontWeight: '800'},
  close: {width: 30, height: 30, alignItems: 'center', justifyContent: 'center'},
  subtitle: {fontSize: 12, fontWeight: '600', marginTop: 4},
  track: {height: 6, borderRadius: 3, overflow: 'hidden', marginTop: 18},
  fill: {height: '100%', borderRadius: 3},
  metaRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 8},
  meta: {flex: 1, fontSize: 11, fontWeight: '600'},
  percent: {fontSize: 12, fontWeight: '800'},
  statusRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12},
  status: {flex: 1, fontSize: 12, fontWeight: '600', lineHeight: 17},
  logWrap: {borderWidth: 1, borderRadius: 10, marginTop: 14, paddingHorizontal: 12, paddingBottom: 10},
  logHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10},
  logTitle: {fontSize: 11, fontWeight: '700'},
});
