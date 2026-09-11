import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import type {StyleProp, ViewStyle} from 'react-native';
import {Colors} from '../theme/colors';

type Props = {
  logs: string[];
  colors: Colors;
  placeholder?: string;
  maxHeight?: number;
  style?: StyleProp<ViewStyle>;
};

/** 插件安装与应用更新共用的日志面板：等宽字体、可滚动，默认只展示最近输出。 */
export default function LogConsole({logs, colors, placeholder = '等待输出…', maxHeight = 180, style}: Props) {
  return (
    <View style={[styles.container, {borderTopColor: colors.border}, style]}>
      <ScrollView nestedScrollEnabled style={{maxHeight}}>
        <Text style={[styles.log, {color: colors.muted}]}>{logs.join('\n') || placeholder}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {marginTop: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth},
  log: {fontFamily: 'monospace', fontSize: 11},
});
