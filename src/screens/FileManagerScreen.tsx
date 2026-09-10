import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, BackHandler, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerLeftUp,
  FileText,
  Folder,
  FolderOpen,
  Move,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react-native';
import {karinFileService, FileEntry} from '../services/karinFileService';
import ConfirmDialog from '../components/ConfirmDialog';
import {Colors} from '../theme/colors';
import {primaryTextStyle} from '../theme/styles';

type Props = {
  colors: Colors;
  onBack: () => void;
};

type Editing = {
  rel: string;
  name: string;
  draft: string;
  hint: string;
  saving: boolean;
  /** 内容是否已从容器读取完成。 */
  loaded: boolean;
  /** view=高亮只读；edit=纯文本编辑。 */
  mode: 'view' | 'edit';
};

/** 浏览视图顶部的一行操作结果提示。 */
type Notice = {
  text: string;
  error: boolean;
};

/** 复制/移动的目标目录选择器状态。 */
type Transfer = {
  mode: 'copy' | 'move';
  entry: FileEntry;
  dir: string; // 选择器当前目录，相对 /root/karin，'' 为根
  dirs: FileEntry[] | null; // 当前目录下的子目录
  error: string;
  busy: boolean;
};

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** Karin 项目（/root/karin）文件浏览与编辑。 */
export default function FileManagerScreen({colors, onBack}: Props) {
  const [path, setPath] = useState(''); // 相对 /root/karin 的当前目录，'' 为根
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [listError, setListError] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [menuEntry, setMenuEntry] = useState<FileEntry | null>(null); // 长按弹出的操作菜单目标
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [creating, setCreating] = useState<{name: string; error: string; busy: boolean} | null>(null);

  const load = useCallback((dir: string) => {
    setEntries(null);
    setListError('');
    karinFileService
      .list(dir)
      .then(setEntries)
      .catch(error => setListError(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    if (!editing) load(path);
  }, [path, editing, load]);

  // 操作结果提示自动消失：成功 5 秒，错误 10 秒
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.error ? 10_000 : 5_000);
    return () => clearTimeout(timer);
  }, [notice]);

  // 编辑视图的保存提示自动消失：成功 5 秒，失败 10 秒
  useEffect(() => {
    if (!editing?.hint) return;
    const timer = setTimeout(
      () => setEditing(current => (current ? {...current, hint: ''} : current)),
      editing.hint === '已保存' ? 5_000 : 10_000,
    );
    return () => clearTimeout(timer);
  }, [editing?.hint]);

  // 接管系统返回手势：编辑中回列表，子目录回上级，根目录退出文件管理
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (editing) {
        setEditing(null);
        return true;
      }
      if (path) {
        setNotice(null);
        setPath(current => current.split('/').slice(0, -1).join('/'));
        return true;
      }
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [editing, path, onBack]);

  const relOf = (name: string) => (path ? `${path}/${name}` : name);

  const enterDir = (name: string) => {
    setNotice(null);
    setPath(current => (current ? `${current}/${name}` : name));
  };
  const goUp = () => {
    setNotice(null);
    setPath(current => current.split('/').slice(0, -1).join('/'));
  };

  const openFile = (name: string) => {
    const rel = relOf(name);
    setEditing({rel, name, draft: '', hint: '', saving: false, loaded: false, mode: 'view'});
    karinFileService
      .readFile(rel)
      .then(content =>
        setEditing(current => (current && current.rel === rel ? {...current, draft: content, loaded: true} : current)),
      )
      .catch(error =>
        setEditing(current =>
          current && current.rel === rel
            ? {...current, loaded: true, hint: `读取失败: ${error instanceof Error ? error.message : String(error)}`}
            : current,
        ),
      );
  };

  const saveFile = () => {
    if (!editing || editing.saving) return;
    setEditing({...editing, saving: true, hint: ''});
    karinFileService
      .writeFile(editing.rel, editing.draft)
      .then(() => setEditing(current => (current ? {...current, saving: false, hint: '已保存'} : current)))
      .catch(error =>
        setEditing(current =>
          current ? {...current, saving: false, hint: `保存失败: ${error instanceof Error ? error.message : String(error)}`} : current,
        ),
      );
  };

  /** 确认新建文件/目录。 */
  const confirmCreate = (isDir: boolean) => {
    if (!creating || creating.busy) return;
    const name = creating.name.trim();
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      setCreating({...creating, error: '名称无效：不能为空，且不能包含 / 或 \\'});
      return;
    }
    const rel = path ? `${path}/${name}` : name;
    setCreating({...creating, busy: true, error: ''});
    (isDir ? karinFileService.createDirectory(rel) : karinFileService.createFile(rel))
      .then(() => {
        setNotice({text: `已创建${isDir ? '目录' : '文件'} ${name}`, error: false});
        setCreating(null);
        load(path);
      })
      .catch(error =>
        setCreating(current =>
          current ? {...current, busy: false, error: error instanceof Error ? error.message : String(error)} : current,
        ),
      );
  };

  /** 删除确认框的确认回调：删完刷新当前目录并提示。 */
  const confirmDelete = () => {
    if (!deleteTarget) return;
    const rel = relOf(deleteTarget.name);
    setDeleteTarget(null);
    karinFileService
      .remove(rel)
      .then(() => {
        setNotice({text: `已删除 ${deleteTarget.name}`, error: false});
        load(path);
      })
      .catch(error => setNotice({text: `删除失败: ${error instanceof Error ? error.message : String(error)}`, error: true}));
  };

  /** 打开复制/移动的目录选择器。 */
  const openTransfer = (mode: Transfer['mode'], entry: FileEntry) => {
    setMenuEntry(null);
    setTransfer({mode, entry, dir: '', dirs: null, error: '', busy: false});
    loadTransferDirs('');
  };

  const loadTransferDirs = (dir: string) => {
    karinFileService
      .list(dir)
      .then(list =>
        setTransfer(current =>
          current && current.dir === dir ? {...current, dirs: list.filter(entry => entry.isDir), error: ''} : current,
        ),
      )
      .catch(error =>
        setTransfer(current =>
          current && current.dir === dir
            ? {...current, dirs: [], error: error instanceof Error ? error.message : String(error)}
            : current,
        ),
      );
  };

  const transferEnter = (name: string) => {
    if (!transfer || transfer.busy) return;
    const dir = transfer.dir ? `${transfer.dir}/${name}` : name;
    setTransfer({...transfer, dir, dirs: null, error: ''});
    loadTransferDirs(dir);
  };

  const transferUp = () => {
    if (!transfer || transfer.busy) return;
    const dir = transfer.dir.split('/').slice(0, -1).join('/');
    setTransfer({...transfer, dir, dirs: null, error: ''});
    loadTransferDirs(dir);
  };

  /** 确认复制/移动到选择器当前目录。 */
  const confirmTransfer = () => {
    if (!transfer || transfer.busy) return;
    const src = relOf(transfer.entry.name);
    const dst = transfer.dir ? `${transfer.dir}/${transfer.entry.name}` : transfer.entry.name;
    const run = transfer.mode === 'copy' ? karinFileService.copy : karinFileService.move;
    setTransfer({...transfer, busy: true, error: ''});
    run(src, dst)
      .then(() => {
        setNotice({text: transfer.mode === 'copy' ? `已复制到 /root/karin/${dst}` : `已移动到 /root/karin/${dst}`, error: false});
        setTransfer(null);
        load(path);
      })
      .catch(error =>
        setTransfer(current =>
          current ? {...current, busy: false, error: error instanceof Error ? error.message : String(error)} : current,
        ),
      );
  };

  if (editing) {
    return (
      <View style={styles.container}>
        <View style={[styles.header, {borderBottomColor: colors.border}]}>
          <Pressable onPress={() => setEditing(null)} style={styles.headerButton}>
            <ChevronLeft size={20} color={colors.text} />
          </Pressable>
          <Text numberOfLines={1} style={[styles.headerTitle, {color: colors.text}]}>
            {editing.name}
          </Text>
          {editing.mode === 'view' ? (
            <Pressable
              onPress={() => setEditing(current => (current ? {...current, mode: 'edit', hint: ''} : current))}
              disabled={!editing.loaded}
              style={[styles.saveButton, {backgroundColor: colors.accentSoft}]}>
              <Pencil size={13} color={colors.accent} />
              <Text style={[styles.editButtonText, {color: colors.accent}]}>编辑</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={saveFile}
              disabled={editing.saving}
              style={[styles.saveButton, {backgroundColor: colors.accent}]}>
              {editing.saving ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <>
                  <Save size={13} color="#FFFFFF" />
                  <Text style={primaryTextStyle}>保存</Text>
                </>
              )}
            </Pressable>
          )}
        </View>
        {editing.hint ? (
          <Text style={[styles.hint, {color: editing.hint === '已保存' ? colors.success : colors.danger}]}>
            {editing.hint}
          </Text>
        ) : null}
        <View style={[styles.editorWrap, {backgroundColor: colors.surface, borderColor: colors.border}]}>
          {!editing.loaded ? (
            <View style={styles.stateBox}>
              <ActivityIndicator size="small" color={colors.accent} />
            </View>
          ) : editing.mode === 'view' ? (
            <ScrollView style={styles.readOnlyScroll} nestedScrollEnabled>
              <Text selectable style={[styles.readOnlyText, {color: colors.text}]}>
                {editing.draft}
              </Text>
            </ScrollView>
          ) : (
            <TextInput
              style={[styles.plainEditor, {color: colors.text}]}
              value={editing.draft}
              multiline
              scrollEnabled
              textAlignVertical="top"
              onChangeText={draft => setEditing(current => (current ? {...current, draft} : current))}
            />
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, {borderBottomColor: colors.border}]}>
        <Pressable onPress={onBack} style={styles.headerButton}>
          <ChevronLeft size={20} color={colors.text} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={[styles.headerTitle, {color: colors.text}]}>文件管理</Text>
          <Text numberOfLines={1} style={[styles.headerPath, {color: colors.muted}]}>
            /root/karin{path ? `/${path}` : ''}
          </Text>
        </View>
        <Pressable onPress={() => setCreating({name: '', error: '', busy: false})} style={styles.headerButton}>
          <Plus size={18} color={colors.text} />
        </Pressable>
        <Pressable onPress={() => load(path)} style={styles.headerButton}>
          <RefreshCw size={16} color={colors.muted} />
        </Pressable>
      </View>

      {notice ? (
        <Text style={[styles.hint, {color: notice.error ? colors.danger : colors.success}]}>{notice.text}</Text>
      ) : null}

      {path ? (
        <Pressable onPress={goUp} style={[styles.row, {borderBottomColor: colors.border}]}>
          <Folder size={17} color={colors.muted} />
          <Text style={[styles.rowName, {color: colors.muted}]}>..</Text>
        </Pressable>
      ) : null}

      {entries === null && !listError ? (
        <View style={styles.stateBox}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={[styles.stateText, {color: colors.muted}]}>正在读取目录…</Text>
        </View>
      ) : listError ? (
        <View style={styles.stateBox}>
          <Text style={[styles.stateText, {color: colors.danger}]}>{listError}</Text>
          <Pressable onPress={() => load(path)} style={[styles.retryButton, {borderColor: colors.border}]}>
            <Text style={[styles.retryText, {color: colors.accent}]}>重试</Text>
          </Pressable>
        </View>
      ) : entries && entries.length === 0 ? (
        <View style={styles.stateBox}>
          <Text style={[styles.stateText, {color: colors.muted}]}>空目录</Text>
        </View>
      ) : (
        <ScrollView style={styles.list}>
          {(entries ?? []).map(entry => (
            <Pressable
              key={entry.name}
              onPress={() => (entry.isDir ? enterDir(entry.name) : setMenuEntry(entry))}
              onLongPress={() => setMenuEntry(entry)}
              style={[styles.row, {borderBottomColor: colors.border}]}>
              {entry.isDir ? <Folder size={17} color={colors.orange} /> : <FileText size={17} color={colors.muted} />}
              <Text numberOfLines={1} style={[styles.rowName, {color: colors.text}]}>
                {entry.name}
              </Text>
              {entry.isDir ? (
                <ChevronRight size={15} color={colors.muted} />
              ) : (
                <Text style={[styles.rowSize, {color: colors.muted}]}>{formatSize(entry.size)}</Text>
              )}
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* 长按弹出的文件/目录操作菜单 */}
      {menuEntry ? (
        <Modal transparent visible animationType="fade" onRequestClose={() => setMenuEntry(null)}>
          <View style={styles.backdrop}>
            <View style={[styles.modal, {backgroundColor: colors.surface}]}>
              <Text numberOfLines={1} style={[styles.modalTitle, {color: colors.text}]}>
                {menuEntry.name}
              </Text>
              <Text style={[styles.modalBody, {color: colors.muted}]}>
                {menuEntry.isDir ? '目录' : `文件 · ${formatSize(menuEntry.size)}`}
              </Text>
              <View style={styles.menuList}>
                <Pressable
                  onPress={() => {
                    const entry = menuEntry;
                    setMenuEntry(null);
                    if (entry.isDir) enterDir(entry.name);
                    else openFile(entry.name);
                  }}
                  style={styles.menuRow}>
                  <FolderOpen size={16} color={colors.text} />
                  <Text style={[styles.menuText, {color: colors.text}]}>打开</Text>
                </Pressable>
                <Pressable onPress={() => openTransfer('copy', menuEntry)} style={styles.menuRow}>
                  <Copy size={16} color={colors.text} />
                  <Text style={[styles.menuText, {color: colors.text}]}>复制</Text>
                </Pressable>
                <Pressable onPress={() => openTransfer('move', menuEntry)} style={styles.menuRow}>
                  <Move size={16} color={colors.text} />
                  <Text style={[styles.menuText, {color: colors.text}]}>移动</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setMenuEntry(null);
                    setDeleteTarget(menuEntry);
                  }}
                  style={styles.menuRow}>
                  <Trash2 size={16} color={colors.danger} />
                  <Text style={[styles.menuText, {color: colors.danger}]}>删除</Text>
                </Pressable>
              </View>
              <Pressable
                onPress={() => setMenuEntry(null)}
                style={[styles.modalButton, {borderColor: colors.border}]}>
                <X size={14} color={colors.muted} />
                <Text style={[styles.modalButtonText, {color: colors.text}]}>取消</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : null}

      {/* 复制/移动的目标目录选择器（只列目录，根为 /root/karin） */}
      {transfer ? (
        <Modal
          transparent
          visible
          animationType="fade"
          onRequestClose={() => {
            if (!transfer.busy) setTransfer(null);
          }}>
          <View style={styles.backdrop}>
            <View style={[styles.modal, {backgroundColor: colors.surface}]}>
              <Text style={[styles.modalTitle, {color: colors.text}]}>
                {transfer.mode === 'copy' ? '复制到' : '移动到'}
              </Text>
              <Text numberOfLines={1} style={[styles.modalBody, {color: colors.muted}]}>
                {transfer.entry.name} → /root/karin{transfer.dir ? `/${transfer.dir}` : ''}
              </Text>
              <View style={[styles.pickerBox, {borderColor: colors.border}]}>
                {transfer.dir ? (
                  <Pressable onPress={transferUp} style={[styles.row, {borderBottomColor: colors.border}]}>
                    <CornerLeftUp size={15} color={colors.muted} />
                    <Text style={[styles.rowName, {color: colors.muted}]}>..</Text>
                  </Pressable>
                ) : null}
                {transfer.dirs === null ? (
                  <View style={styles.pickerState}>
                    <ActivityIndicator size="small" color={colors.accent} />
                  </View>
                ) : transfer.dirs.length === 0 ? (
                  <View style={styles.pickerState}>
                    <Text style={[styles.stateText, {color: colors.muted}]}>无子目录</Text>
                  </View>
                ) : (
                  <ScrollView style={styles.pickerList}>
                    {transfer.dirs.map(dir => (
                      <Pressable
                        key={dir.name}
                        onPress={() => transferEnter(dir.name)}
                        style={[styles.row, {borderBottomColor: colors.border}]}>
                        <Folder size={15} color={colors.orange} />
                        <Text numberOfLines={1} style={[styles.rowName, {color: colors.text}]}>
                          {dir.name}
                        </Text>
                        <ChevronRight size={14} color={colors.muted} />
                      </Pressable>
                    ))}
                  </ScrollView>
                )}
              </View>
              {transfer.error ? (
                <Text style={[styles.pickerError, {color: colors.danger}]}>{transfer.error}</Text>
              ) : null}
              <View style={styles.modalActions}>
                <Pressable
                  onPress={() => setTransfer(null)}
                  disabled={transfer.busy}
                  style={[styles.modalButton, styles.modalAction, {borderColor: colors.border}]}>
                  <Text style={[styles.modalButtonText, {color: colors.text}]}>取消</Text>
                </Pressable>
                <Pressable
                  onPress={confirmTransfer}
                  disabled={transfer.busy}
                  style={[styles.modalButton, styles.modalAction, {backgroundColor: colors.accent, borderColor: colors.accent}]}>
                  {transfer.busy ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Text style={primaryTextStyle}>{transfer.mode === 'copy' ? '复制到此处' : '移动到此处'}</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}

      <ConfirmDialog
        visible={deleteTarget !== null}
        title="删除确认"
        body={
          deleteTarget
            ? `确定删除${deleteTarget.isDir ? '目录' : '文件'}“${deleteTarget.name}”吗？${
                deleteTarget.isDir ? '目录内所有内容将一并删除，' : ''
              }此操作不可撤销。`
            : ''
        }
        confirmText="删除"
        colors={colors}
        onConfirm={confirmDelete}
        onClose={() => setDeleteTarget(null)}
      />

      {/* 新建文件/目录 */}
      {creating ? (
        <Modal transparent visible animationType="fade" onRequestClose={() => { if (!creating.busy) setCreating(null); }}>
          <View style={styles.backdrop}>
            <View style={[styles.modal, {backgroundColor: colors.surface}]}>
              <Text style={[styles.modalTitle, {color: colors.text}]}>新建</Text>
              <Text numberOfLines={1} style={[styles.modalBody, {color: colors.muted}]}>
                位于 /root/karin{path ? `/${path}` : ''}
              </Text>
              <TextInput
                value={creating.name}
                onChangeText={name => setCreating({...creating, name, error: ''})}
                placeholder="输入名称"
                placeholderTextColor={colors.muted}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.nameInput, {color: colors.text, borderColor: colors.border}]}
              />
              {creating.error ? (
                <Text style={[styles.pickerError, {color: colors.danger}]}>{creating.error}</Text>
              ) : null}
              <View style={styles.modalActions}>
                <Pressable
                  onPress={() => confirmCreate(false)}
                  disabled={creating.busy}
                  style={[styles.modalButton, styles.modalAction, {borderColor: colors.border}]}>
                  <FileText size={14} color={colors.text} />
                  <Text style={[styles.modalButtonText, {color: colors.text}]}>文件</Text>
                </Pressable>
                <Pressable
                  onPress={() => confirmCreate(true)}
                  disabled={creating.busy}
                  style={[styles.modalButton, styles.modalAction, {borderColor: colors.border}]}>
                  <Folder size={14} color={colors.text} />
                  <Text style={[styles.modalButtonText, {color: colors.text}]}>目录</Text>
                </Pressable>
              </View>
              <Pressable
                onPress={() => setCreating(null)}
                disabled={creating.busy}
                style={[styles.modalButton, {borderColor: colors.border}]}>
                <Text style={[styles.modalButtonText, {color: colors.text}]}>取消</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  header: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1},
  headerButton: {width: 34, height: 34, alignItems: 'center', justifyContent: 'center'},
  headerCopy: {flex: 1},
  headerTitle: {fontSize: 15, fontWeight: '800'},
  headerPath: {fontSize: 10, marginTop: 2},
  saveButton: {flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7},
  editButtonText: {fontSize: 12, fontWeight: '800'},
  hint: {fontSize: 11, fontWeight: '600', paddingHorizontal: 14, paddingTop: 8},
  editorWrap: {flex: 1, margin: 12, borderRadius: 10, borderWidth: 1, overflow: 'hidden'},
  readOnlyScroll: {flex: 1},
  readOnlyText: {padding: 10, fontFamily: 'monospace', fontSize: 12, lineHeight: 18},
  plainEditor: {flex: 1, padding: 10, fontFamily: 'monospace', fontSize: 12, lineHeight: 18},
  list: {flex: 1},
  row: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth},
  rowName: {flex: 1, fontSize: 13, fontWeight: '600'},
  rowSize: {fontSize: 11},
  stateBox: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10},
  stateText: {fontSize: 12, fontWeight: '600'},
  retryButton: {borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6},
  retryText: {fontSize: 12, fontWeight: '700'},
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.46)', alignItems: 'center', justifyContent: 'center', padding: 24},
  modal: {width: '100%', borderRadius: 16, padding: 20},
  modalTitle: {fontSize: 17, fontWeight: '800'},
  modalBody: {fontSize: 12, lineHeight: 18, marginTop: 6},
  menuList: {marginTop: 14},
  menuRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11},
  menuText: {fontSize: 13, fontWeight: '700'},
  modalActions: {flexDirection: 'row', gap: 8, marginTop: 14},
  modalAction: {flex: 1},
  modalButton: {flexDirection: 'row', minHeight: 40, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, paddingHorizontal: 8},
  modalButtonText: {fontSize: 12, fontWeight: '700'},
  pickerBox: {height: 220, borderWidth: 1, borderRadius: 10, marginTop: 12, overflow: 'hidden'},
  pickerList: {flex: 1},
  pickerState: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  pickerError: {fontSize: 11, fontWeight: '600', marginTop: 8},
  nameInput: {borderWidth: 1, borderRadius: 10, marginTop: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 13, fontFamily: 'monospace'},
});
