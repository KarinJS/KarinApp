import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {TABS} from '../constants/navigation';
import {Colors} from '../theme/colors';
import type {Tab} from '../types';

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
  nav: {height: 72, borderTopWidth: 1, flexDirection: 'row', paddingBottom: 4},
  item: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4},
  label: {fontSize: 11, fontWeight: '700'},
});
