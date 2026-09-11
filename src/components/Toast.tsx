import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Colors} from '../theme/colors';

type Props = {
  message: string;
  colors: Colors;
  /** 距父容器底部的距离；默认按「父容器含底部导航」的首页取值 */
  bottomOffset?: number;
};

/** 首页里 Toast 浮在底部导航上方的高度；子页面容器不含导航，按 BOTTOM_NAV_HEIGHT 换算后再传 */
export const TOAST_BOTTOM_OFFSET = 152;

export default function Toast({message, colors, bottomOffset = TOAST_BOTTOM_OFFSET}: Props) {
  return (
    <View style={[styles.toast, {backgroundColor: colors.toast, bottom: bottomOffset}]}>
      <Text style={[styles.text, {color: colors.toastText}]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 20,
    right: 20,
    padding: 13,
    borderRadius: 10,
    alignItems: 'center',
    zIndex: 20,
    elevation: 20,
  },
  text: {fontSize: 13, fontWeight: '600'},
});
