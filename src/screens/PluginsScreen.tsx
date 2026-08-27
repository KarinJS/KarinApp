import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {TABS} from '../constants/navigation';
import {Colors} from '../theme/colors';

type Props = {
  colors: Colors;
};

export default function PluginsScreen({colors}: Props) {
  const plugin = TABS.find(tab => tab.label === '插件');
  const Icon = plugin?.icon;

  return (
    <View style={styles.placeholder}>
      {Icon ? <Icon size={44} color={colors.accent} /> : null}
      <Text style={[styles.title, {color: colors.text}]}>插件</Text>
      <Text style={[styles.copy, {color: colors.muted}]}>功能模块占位，后续接入真实能力</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30},
  title: {fontSize: 24, fontWeight: '800', marginTop: 15},
  copy: {fontSize: 13, marginTop: 7},
});
