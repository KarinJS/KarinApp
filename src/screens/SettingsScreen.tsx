import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {ChevronRight} from 'lucide-react-native';
import {Colors} from '../theme/colors';

type Props = {
  colors: Colors;
  version: string;
  onOpen: () => void;
};

export default function SettingsScreen({colors, version, onOpen}: Props) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[styles.intro, {color: colors.muted}]}>统一管理容器运行环境与 Karin 版本</Text>
      <View style={[styles.list, {backgroundColor: colors.surface, borderColor: colors.border}]}>
        <Pressable onPress={onOpen} style={styles.row}>
          <View style={styles.copy}>
            <Text style={[styles.label, {color: colors.text}]}>Karin 版本</Text>
            <Text style={[styles.value, {color: colors.muted}]}>{version}</Text>
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
  list: {borderWidth: 1, borderRadius: 13, overflow: 'hidden'},
  row: {minHeight: 62, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  copy: {gap: 4},
  label: {fontSize: 14, fontWeight: '700'},
  value: {fontSize: 11, fontWeight: '600'},
});
