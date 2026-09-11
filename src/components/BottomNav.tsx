import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {TABS} from '../constants/navigation';
import {Colors} from '../theme/colors';
import type {Tab} from '../types';

/** 底部导航高度；首页的 Toast 就浮在它上方，子页面用它换算同样的高度 */
export const BOTTOM_NAV_HEIGHT = 72;

type Props = {
  activeTab: Tab;
  colors: Colors;
  onSelect: (tab: Tab) => void;
};

export default function BottomNav({activeTab, colors, onSelect}: Props) {
  return (
    <View style={[styles.nav, {backgroundColor: colors.surface, borderTopColor: colors.border}]}>
      {TABS.map(tab => {
        const active = activeTab === tab.label;
        const Icon = tab.icon;
        const color = active ? colors.accent : colors.muted;
        return (
          <Pressable key={tab.label} onPress={() => onSelect(tab.label)} style={styles.item}>
            <Icon size={21} color={color} />
            <Text style={[styles.label, {color}]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  nav: {height: BOTTOM_NAV_HEIGHT, borderTopWidth: 1, flexDirection: 'row', paddingBottom: 4},
  item: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4},
  label: {fontSize: 11, fontWeight: '700'},
});
