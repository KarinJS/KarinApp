import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {ArrowDownToLine} from 'lucide-react-native';
import {Colors} from '../theme/colors';

type Props = {
  colors: Colors;
  /** 0~1，-1 表示总大小未知 */
  progress: number;
  /** 下载失败或中断：角标转成红色感叹号 */
  failed?: boolean;
  onPress: () => void;
};

const SIZE = 52;

/** 下载任务悬浮按钮：图标右上角显示进度百分比，失败时变成红色感叹号。 */
export default function UpdateTaskFab({colors, progress, failed, onPress}: Props) {
  const percent = progress >= 0 ? Math.floor(Math.min(1, progress) * 100) : -1;
  const badge = failed ? '!' : percent >= 0 ? `${percent}%` : '…';
  const badgeTextColor = failed ? '#FFFFFF' : colors.accent;
  return (
    <Pressable
      accessibilityLabel="下载任务"
      accessibilityRole="button"
      onPress={onPress}
      style={({pressed}) => [styles.fab, {backgroundColor: colors.accent}, pressed ? styles.pressed : null]}>
      <ArrowDownToLine color="#FFFFFF" size={22} strokeWidth={2.4} />
      <View style={[styles.badge, {backgroundColor: failed ? colors.danger : colors.surface, borderColor: colors.surface}]}>
        <Text style={[styles.badgeText, {color: badgeTextColor}]}>{badge}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 20,
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 8,
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: {width: 0, height: 3},
  },
  pressed: {opacity: 0.85},
  badge: {
    position: 'absolute',
    top: -3,
    right: -6,
    minWidth: 26,
    paddingHorizontal: 4,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {fontSize: 10, fontWeight: '800'},
});
