import React from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {Colors} from '../theme/colors';
import {primaryTextStyle} from '../theme/styles';

type Props = {
  visible: boolean;
  title: string;
  body: string;
  confirmText: string;
  colors: Colors;
  onConfirm: () => void;
  onClose: () => void;
};

/** 通用确认弹窗（危险操作二次确认，确认键为警示色）。 */
export default function ConfirmDialog({visible, title, body, confirmText, colors, onConfirm, onClose}: Props) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.modal, {backgroundColor: colors.surface}]}>
          <Text style={[styles.title, {color: colors.text}]}>{title}</Text>
          <Text style={[styles.body, {color: colors.muted}]}>{body}</Text>
          <View style={styles.actions}>
            <Pressable onPress={onClose} style={[styles.button, {borderColor: colors.border}]}>
              <Text style={[styles.buttonText, {color: colors.text}]}>取消</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              style={[styles.button, {backgroundColor: colors.danger, borderColor: colors.danger}]}>
              <Text style={primaryTextStyle}>{confirmText}</Text>
            </Pressable>
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
