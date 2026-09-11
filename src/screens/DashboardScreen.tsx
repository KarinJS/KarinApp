import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Cpu, FolderOpen, MemoryStick, Terminal as TerminalIcon} from 'lucide-react-native';
import {Colors} from '../theme/colors';

type Props = {
  colors: Colors;
  karinRunning: boolean;
  karinSeconds: number;
  memoryBytes: number;
  onOpenFiles: () => void;
  onOpenLogs: () => void;
};

function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export default function DashboardScreen({colors, karinRunning, karinSeconds, memoryBytes, onOpenFiles, onOpenLogs}: Props) {
  return (
    <ScrollView contentContainerStyle={styles.dashboard}>
      <View style={[styles.statusRow, {backgroundColor: colors.surface, borderColor: colors.border}]}>
        <View style={[styles.statusDot, {backgroundColor: karinRunning ? colors.success : colors.muted}]} />
        <View style={styles.statusRowContent}>
          <Text style={[styles.infoLabel, {color: colors.muted}]}>Karin 服务</Text>
          <Text style={[styles.statusRowValue, {color: karinRunning ? colors.text : colors.muted}]}>
            {karinRunning ? runtimeLabel(karinSeconds) : '未运行'}
          </Text>
        </View>
        <Text style={[styles.statusRowHint, {color: colors.muted}]}>右下角开关控制</Text>
      </View>

      <View style={styles.infoGrid}>
        <InfoCard
          title="内存占用"
          value={karinRunning ? formatMemory(memoryBytes) : '--'}
          description="当前 Karin 使用量"
          color={colors.purple}
          softColor={colors.purpleSoft}
          icon="memory"
          colors={colors}
        />
        <InfoCard
          title="系统架构"
          value="arm64"
          description="Android 运行环境"
          color={colors.orange}
          softColor={colors.orangeSoft}
          icon="cpu"
          colors={colors}
        />
      </View>

      <Text style={[styles.sectionTitle, {color: colors.text}]}>快捷操作</Text>
      <View style={styles.actions}>
        <Action title="运行日志" subtitle="查看日志、发送控制台命令" icon="terminal" colors={colors} onPress={onOpenLogs} />
        <Action title="文件管理" subtitle="查看 Karin 项目文件" icon="folder" colors={colors} onPress={onOpenFiles} />
      </View>
    </ScrollView>
  );
}

function runtimeLabel(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, '0');
  const minutes = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60)
    .toString()
    .padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

type InfoCardProps = {
  title: string;
  value: string;
  description: string;
  color: string;
  softColor: string;
  icon: 'memory' | 'cpu';
  colors: Colors;
};

function InfoCard({title, value, description, color, softColor, icon, colors}: InfoCardProps) {
  return (
    <View style={[styles.infoCard, {backgroundColor: colors.surface, borderColor: colors.border}]}>
      <View style={[styles.infoIcon, {backgroundColor: softColor}]}>
        <InfoIcon name={icon} color={color} />
      </View>
      <Text style={[styles.infoLabel, {color: colors.muted}]}>{title}</Text>
      <Text style={[styles.infoValue, {color: colors.text}]}>{value}</Text>
      <Text style={[styles.infoDescription, {color: colors.muted}]}>{description}</Text>
    </View>
  );
}

function InfoIcon({name, color}: {name: 'memory' | 'cpu'; color: string}) {
  return name === 'cpu' ? <Cpu size={15} color={color} /> : <MemoryStick size={15} color={color} />;
}

type ActionProps = {
  title: string;
  subtitle: string;
  icon: 'terminal' | 'folder';
  colors: Colors;
  onPress: () => void;
};

function Action({title, subtitle, icon, colors, onPress}: ActionProps) {
  const glyph = icon === 'terminal' ? <TerminalIcon size={22} color={colors.accent} /> : <FolderOpen size={22} color={colors.accent} />;
  return (
    <Pressable onPress={onPress} style={[styles.action, {backgroundColor: colors.surface, borderColor: colors.border}]}>
      <View style={styles.actionIcon}>{glyph}</View>
      <View>
        <Text style={[styles.actionTitle, {color: colors.text}]}>{title}</Text>
        <Text style={[styles.actionSubtitle, {color: colors.muted}]}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  dashboard: {padding: 16, paddingTop: 4, paddingBottom: 104},
  statusRow: {borderRadius: 12, borderWidth: 1, padding: 13, flexDirection: 'row', alignItems: 'center'},
  statusDot: {width: 10, height: 10, borderRadius: 5, marginRight: 11},
  statusRowContent: {flex: 1},
  statusRowValue: {fontSize: 17, fontWeight: '800', marginTop: 3},
  statusRowHint: {fontSize: 10},
  infoGrid: {flexDirection: 'row', gap: 8, marginTop: 8},
  infoCard: {flex: 1, minHeight: 102, borderRadius: 12, borderWidth: 1, padding: 11},
  infoIcon: {width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginBottom: 8},
  infoLabel: {fontSize: 10, fontWeight: '600'},
  infoValue: {fontSize: 17, fontWeight: '800', marginTop: 4},
  infoDescription: {fontSize: 9, lineHeight: 12, marginTop: 3},
  sectionTitle: {fontSize: 17, fontWeight: '800', marginTop: 25, marginBottom: 11},
  actions: {gap: 10},
  action: {borderRadius: 12, borderWidth: 1, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14},
  actionIcon: {width: 32, textAlign: 'center'},
  actionTitle: {fontSize: 15, fontWeight: '700'},
  actionSubtitle: {fontSize: 12, marginTop: 4},
});
