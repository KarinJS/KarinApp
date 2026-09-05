import React, {useRef, useState} from 'react';
import {StyleSheet, TextInput, TextInputKeyPressEvent, TextInputSelectionChangeEvent} from 'react-native';
import {Colors} from '../theme/colors';

type Props = {
  colors: Colors;
  value: string;
  onChangeText: (text: string) => void;
};

/** 取 text 中 pos 光标所在行的前导缩进。 */
function indentAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, pos))?.[0] ?? '';
}

/** 纯文本代码编辑器：等宽字体、固定行高，回车时自动继承上一行缩进。 */
export default function CodeEditor({colors, value, onChangeText}: Props) {
  const selectionRef = useRef({start: 0, end: 0});
  // onKeyPress 记录回车时的光标位置与缩进，等 onChangeText 时把换行替换成 换行+缩进
  const pendingEnterRef = useRef<{start: number; end: number; indent: string} | null>(null);
  // 仅用于换行补缩进后的光标归位；null 时 selection 不受控
  const [cursor, setCursor] = useState<number | null>(null);

  const handleSelectionChange = (e: TextInputSelectionChangeEvent) => {
    const sel = e.nativeEvent.selection;
    selectionRef.current = sel;
    // 原生侧已应用补缩进后的光标位置，释放受控 selection
    if (cursor !== null && sel.start === cursor && sel.end === cursor) setCursor(null);
  };

  const handleKeyPress = (e: TextInputKeyPressEvent) => {
    if (e.nativeEvent.key !== 'Enter') return;
    const {start, end} = selectionRef.current;
    pendingEnterRef.current = {start, end, indent: indentAt(value, start)};
  };

  const handleChangeText = (text: string) => {
    // onKeyPress 已记录回车：确认变化确为在光标处插入 '\n'，则补上行首缩进
    const pending = pendingEnterRef.current;
    pendingEnterRef.current = null;
    if (pending && pending.indent) {
      const expected = value.slice(0, pending.start) + '\n' + value.slice(pending.end);
      if (text === expected) {
        setCursor(pending.start + 1 + pending.indent.length);
        onChangeText(value.slice(0, pending.start) + '\n' + pending.indent + value.slice(pending.end));
        return;
      }
    }
    // 兜底：部分软键盘不回发 onKeyPress，直接探测单个 '\n' 插入
    if (text.length === value.length + 1) {
      const selStart = selectionRef.current.start;
      for (const pos of [selStart, selStart - 1]) {
        if (pos < 0 || text[pos] !== '\n') continue;
        if (text.slice(0, pos) !== value.slice(0, pos) || text.slice(pos + 1) !== value.slice(pos)) continue;
        const indent = indentAt(value, pos);
        if (!indent) break;
        setCursor(pos + 1 + indent.length);
        onChangeText(value.slice(0, pos) + '\n' + indent + value.slice(pos));
        return;
      }
    }
    onChangeText(text);
  };

  return (
    <TextInput
      style={[styles.input, {color: colors.text}]}
      value={value}
      onChangeText={handleChangeText}
      onKeyPress={handleKeyPress}
      onSelectionChange={handleSelectionChange}
      multiline
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="off"
      spellCheck={false}
      cursorColor={colors.accent}
      selectionColor={colors.accentSoft}
      selection={cursor === null ? undefined : {start: cursor, end: cursor}}
    />
  );
}

const styles = StyleSheet.create({
  input: {flex: 1, padding: 10, fontFamily: 'monospace', fontSize: 12, lineHeight: 18, textAlignVertical: 'top'},
});
