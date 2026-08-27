import React from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {Colors} from '../theme/colors';
import {primaryTextStyle} from '../theme/styles';
import type {ContainerState} from '../types';

type Props = {
  visible: boolean;
  containerState: ContainerState;
  colors: Colors;
  onClose: () => void;
  onRestart: (force: boolean) => void;
};

export default function RestartDialog({visible, containerState, colors, onClose, onRestart}: Props) {
  const stopped = containerState === 'stopped';

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.modal, {backgroundColor: colors.surface}]}>
          <Text style={[styles.title, {color: colors.text}]}>容器操作</Text>
          <Text style={[styles.body, {color: colors.muted}]}>
            {stopped ? 'proot 容器当前已停止，可以重新启动容器。' : '选择重启方式，应用会重新启动 proot 容器。'}
          </Text>
          <View style={styles.actions}>
            <Pressable onPress={onClose} style={[styles.button, {borderColor: colors.border}]}>
              <Text style={[styles.buttonText, {color: colors.text}]}>取消</Text>
            </Pressable>
            <Pressable
              onPress={() => onRestart(false)}
              style={[styles.button, {backgroundColor: colors.accent, borderColor: colors.accent}]}>
              <Text style={primaryTextStyle}>{stopped ? '启动' : '重启'}</Text>
            </Pressable>
            {!stopped ? (
              <Pressable
                onPress={() => onRestart(true)}
                style={[styles.button, {backgroundColor: colors.danger, borderColor: colors.danger}]}>
                <Text style={primaryTextStyle}>强制重启</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.46)', alignItems: 'center', justifyContent: 'center', padding: 24},
  modal: {width: '100%', borderRadius: 16, padding: 20},
  title: {fontSize: 20, fontWeight: '800'},
  body: {fontSize: 13, lineHeight: 19, marginTop: 8},
  actions: {flexDirection: 'row', gap: 8, marginTop: 22},
  button: {flex: 1, minHeight: 42, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5},
  buttonText: {fontSize: 12, fontWeight: '700'},
});
