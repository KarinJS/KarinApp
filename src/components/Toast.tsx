import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Colors} from '../theme/colors';

type Props = {
  message: string;
  colors: Colors;
};

export default function Toast({message, colors}: Props) {
  return (
    <View style={[styles.toast, {backgroundColor: colors.toast}]}>
      <Text style={[styles.text, {color: colors.toastText}]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 152,
    padding: 13,
    borderRadius: 10,
    alignItems: 'center',
    zIndex: 20,
    elevation: 20,
  },
  text: {fontSize: 13, fontWeight: '600'},
});
