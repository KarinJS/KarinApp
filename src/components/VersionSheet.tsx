import React, {useState} from 'react';
import {Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Colors} from '../theme/colors';
import {primaryTextStyle} from '../theme/styles';

type Props = {
  visible: boolean;
  versions: string[];
  selectedVersion: string;
  colors: Colors;
  onSelect: (version: string) => void;
  onConfirm: () => void;
  onClose: () => void;
};

export default function VersionSheet({visible, versions, selectedVersion, colors, onSelect, onConfirm, onClose}: Props) {
  const [expanded, setExpanded] = useState(false);

  const handleSelect = (version: string) => {
    onSelect(version);
    setExpanded(false);
  };

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.dismiss} onPress={onClose} />
        <View style={[styles.sheet, {backgroundColor: colors.surface}]}>
          <Text style={[styles.title, {color: colors.text}]}>选择 Karin 版本</Text>
          <Text style={[styles.body, {color: colors.muted}]}>选择要使用的 Karin 版本</Text>

          <Pressable
            onPress={() => setExpanded(value => !value)}
            style={[styles.select, {borderColor: colors.border}]}>
            <Text style={[styles.versionText, {color: colors.text}]}>{selectedVersion}</Text>
            <View style={styles.selectArrowBox}>
              <View style={[styles.selectArrow, {borderColor: colors.muted}, expanded && styles.selectArrowUp]} />
            </View>
          </Pressable>

          {expanded ? (
            <View style={[styles.picker, {borderColor: colors.border}]}>
              <ScrollView style={styles.list} nestedScrollEnabled>
                {versions.map(version => (
                  <Pressable
                    key={version}
                    onPress={() => handleSelect(version)}
                    style={[styles.option, selectedVersion === version && {backgroundColor: colors.accentSoft}]}>
                    <Text style={[styles.versionText, {color: selectedVersion === version ? colors.accent : colors.text}]}>
                      {version}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}

          <View style={styles.actions}>
            <Pressable onPress={onClose} style={[styles.button, {borderColor: colors.border}]}>
              <Text style={[styles.buttonText, {color: colors.text}]}>取消</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              style={[styles.button, {backgroundColor: colors.accent, borderColor: colors.accent}]}>
              <Text style={primaryTextStyle}>确认</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.42)', justifyContent: 'flex-end'},
  dismiss: {flex: 1},
  sheet: {borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 28},
  title: {fontSize: 20, fontWeight: '800'},
  body: {fontSize: 13, lineHeight: 19, marginTop: 8},
  select: {height: 48, borderWidth: 1, borderRadius: 10, marginTop: 16, paddingLeft: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  selectArrowBox: {width: 46, height: 46, alignItems: 'center', justifyContent: 'center'},
  selectArrow: {width: 8, height: 8, borderRightWidth: 2, borderBottomWidth: 2, transform: [{rotate: '45deg'}], marginTop: -4},
  selectArrowUp: {transform: [{rotate: '225deg'}], marginTop: 4},
  picker: {height: 148, borderWidth: 1, borderRadius: 10, marginTop: 7, overflow: 'hidden'},
  list: {flex: 1},
  option: {height: 44, justifyContent: 'center', paddingHorizontal: 14},
  versionText: {fontSize: 15, fontWeight: '700'},
  actions: {flexDirection: 'row', gap: 8, marginTop: 22},
  button: {flex: 1, minHeight: 42, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5},
  buttonText: {fontSize: 12, fontWeight: '700'},
});
