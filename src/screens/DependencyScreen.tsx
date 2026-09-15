import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, BackHandler, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Check, ChevronLeft, Plus, RefreshCw, RotateCcw, Square, X} from 'lucide-react-native';
import ConfirmDialog from '../components/ConfirmDialog';
import DependencyVersionSheet from '../components/DependencyVersionSheet';
import LogConsole from '../components/LogConsole';
import {Colors} from '../theme/colors';
import {primaryTextStyle} from '../theme/styles';
import {clearPackageVersionCache, pickLatestStableVersion, preloadPackageVersions} from '../services/packageVersions';
import {
  installKarinDependencies,
  KarinDependency,
  listKarinDependencies,
  reinstallKarinDependencies,
  removeKarinDependency,
  updateKarinDependencySpecs,
} from '../services/pluginService';

type Props = {
  /** 依赖变动后通知外层重新读一次容器里的 Karin 版本（node-karin 版本可能被改过） */
  onDepsChanged?: () => void;
  colors: Colors;
  onBack: () => void;
};

type Run = {
  kind: 'install' | 'remove' | 'update' | 'reinstall';
  target: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  logs: string[];
};

/**
 * 依赖管理：Karin 目录 package.json 里声明的运行依赖。
 * 点版本号进入操作菜单，选择版本后立即执行安装；Karin 本体固定置顶。
 */
export default function DependencyScreen({colors, onBack, onDepsChanged}: Props) {
  const [deps, setDeps] = useState<KarinDependency[] | null>(null);
  const [listError, setListError] = useState('');
  const [addPage, setAddPage] = useState<'single' | 'batch'>('single');
  const [addPackage, setAddPackage] = useState('');
  const [addVersion, setAddVersion] = useState('');
  const [addLocation, setAddLocation] = useState<'dependencies' | 'devDependencies' | 'optionalDependencies'>('dependencies');
  const [batchInput, setBatchInput] = useState('');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [removeTarget, setRemoveTarget] = useState<KarinDependency | null>(null);
  const [versionTarget, setVersionTarget] = useState<KarinDependency | null>(null);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [bulkRemoveOpen, setBulkRemoveOpen] = useState(false);
  const [reinstallConfirm, setReinstallConfirm] = useState(false);
  const canceller = useRef<AbortController | null>(null);
  const busy = run?.status === 'running';

  const load = useCallback(() => {
    setDeps(null);
    setListError('');
    listKarinDependencies()
      .then(next => {
        setDeps(next);
        // 先展示本地依赖，再在后台预取版本，打开操作菜单时复用 1 小时缓存。
        preloadPackageVersions(next.map(dep => dep.name)).then(versionMap => {
          setDeps(current =>
            current ? current.map(dep => ({...dep, latestVersion: pickLatestStableVersion(versionMap[dep.name] ?? [])})) : null,
          );
        }).catch(() => undefined);
      })
      .catch(error => setListError(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy) {
        canceller.current?.abort();
        return true;
      }
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [busy, onBack]);

  const start = useCallback(
    async (
      kind: Run['kind'],
      target: string,
      execute: (onLog: (line: string) => void, signal: AbortSignal) => Promise<unknown>,
      onSettled?: (ok: boolean) => void,
    ) => {
      const controller = new AbortController();
      canceller.current = controller;
      setRun({kind, target, status: 'running', logs: []});
      const onLog = (line: string) => setRun(current => (current ? {...current, logs: [...current.logs, line]} : current));
      let ok = true;
      try {
        await execute(onLog, controller.signal);
        setRun(current => (current ? {...current, status: 'done'} : current));
      } catch (caught) {
        ok = false;
        const message = caught instanceof Error ? caught.message : String(caught);
        setRun(current =>
          current
            ? {...current, status: controller.signal.aborted ? 'cancelled' : 'failed', logs: [...current.logs, message]}
            : current,
        );
      } finally {
        canceller.current = null;
        load();
        if (ok) onDepsChanged?.();
        onSettled?.(ok);
      }
    },
    [load, onDepsChanged],
  );

  const submitAddDependency = useCallback(() => {
    if (busy) return;
    const name = addPackage.trim();
    if (!name) return;
    const spec = addVersion.trim() || 'latest';
    const target = `${name}@${spec}`;
    setAddModalOpen(false);
    start('install', target, (onLog, signal) => installKarinDependencies([target], onLog, signal, {
      location: addLocation,
    }));
  }, [addLocation, addPackage, addVersion, busy, start]);

  const submitBatchDependencies = useCallback(() => {
    if (busy) return;
    const names = batchInput.trim().split(/\s+/).filter(Boolean).map(item => {
      const marker = item.startsWith('@') ? item.indexOf('@', 1) : item.indexOf('@');
      return marker > 0 ? item : `${item}@latest`;
    });
    if (!names.length) return;
    setAddModalOpen(false);
    start('install', names.join(' '), (onLog, signal) => installKarinDependencies(names, onLog, signal));
  }, [batchInput, busy, start]);

  const confirmRemove = useCallback(() => {
    const target = removeTarget;
    setRemoveTarget(null);
    if (!target) return;
    start('remove', target.name, (onLog, signal) => removeKarinDependency(target.name, onLog, signal));
  }, [removeTarget, start]);

  const selectableDeps = (deps ?? []).filter(dep => !dep.core);
  const allSelected = selectableDeps.length > 0 && selectableDeps.every(dep => selectedNames.includes(dep.name));
  const toggleSelected = (name: string) => setSelectedNames(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name]);
  const toggleAll = () => setSelectedNames(allSelected ? [] : selectableDeps.map(dep => dep.name));
  const bulkUpdateLatest = useCallback(() => {
    if (busy || !selectedNames.length) return;
    const names = [...selectedNames];
    start('update', `${names.length} 个依赖`, (onLog, signal) => installKarinDependencies(names.map(name => `${name}@latest`), onLog, signal), ok => {
      if (ok) setSelectedNames([]);
    });
  }, [busy, selectedNames, start]);
  const bulkRemove = useCallback(() => {
    if (busy || !selectedNames.length) return;
    const names = [...selectedNames];
    setBulkRemoveOpen(false);
    start('remove', `${names.length} 个依赖`, async (onLog, signal) => {
      for (const name of names) await removeKarinDependency(name, onLog, signal);
    }, ok => {
      if (ok) setSelectedNames([]);
    });
  }, [busy, selectedNames, start]);

  /** 自定义版本由操作菜单的「应用更改」立即写入 package.json 并安装。 */
  const applySpec = useCallback((dep: KarinDependency, spec: string) => {
    if (busy || !spec.trim()) return;
    setVersionTarget(null);
    start('update', `${dep.name}@${spec}`, (onLog, signal) => updateKarinDependencySpecs([{
      name: dep.name,
      spec: spec.trim(),
      dev: dep.dev,
      location: dep.location,
    }], onLog, signal));
  }, [busy, start]);

  const updateLatest = useCallback((dep: KarinDependency) => {
    if (busy) return;
    setVersionTarget(null);
    start('update', `${dep.name}@latest`, (onLog, signal) => updateKarinDependencySpecs([{
      name: dep.name,
      spec: 'latest',
      dev: dep.dev,
      location: dep.location,
    }], onLog, signal));
  }, [busy, start]);

  const confirmReinstall = useCallback(() => {
    setReinstallConfirm(false);
    start('reinstall', '全部依赖', (onLog, signal) => reinstallKarinDependencies(onLog, signal));
  }, [start]);

  /** 刷新只重读 package.json；强制刷新再清版本缓存，下次选版本会重新请求 npm */
  const refresh = useCallback(
    (force: boolean) => {
      if (force) clearPackageVersionCache();
      load();
    },
    [load],
  );

  return (
    <View style={styles.container}>
      <View style={[styles.header, {borderBottomColor: colors.border}]}>
        <Pressable accessibilityLabel='返回设置页' onPress={onBack} style={styles.headerButton}>
          <ChevronLeft color={colors.text} size={20} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={[styles.headerTitle, {color: colors.text}]}>依赖管理</Text>
          <Text numberOfLines={1} style={[styles.headerPath, {color: colors.muted}]}>选择依赖查看版本与操作</Text>
        </View>
        <Pressable
          accessibilityLabel='刷新依赖列表（长按强制刷新并清空版本缓存）'
          disabled={busy}
          onLongPress={() => refresh(true)}
          onPress={() => refresh(false)}
          style={[styles.headerButton, busy && styles.disabled]}>
          <RefreshCw color={colors.muted} size={17} />
        </Pressable>
      </View>

      <Pressable
        accessibilityRole='button'
        accessibilityLabel='重置依赖环境（删除 node_modules 和锁文件后重新安装）'
        disabled={busy}
        onPress={() => setReinstallConfirm(true)}
        style={[styles.reinstallCard, {backgroundColor: colors.surface, borderColor: colors.border}, busy && styles.disabled]}>
        <View style={[styles.reinstallIcon, {backgroundColor: colors.orangeSoft}]}>
          <RotateCcw color={colors.orange} size={18} />
        </View>
        <View style={styles.reinstallCopy}>
          <Text style={[styles.reinstallTitle, {color: colors.text}]}>重置依赖环境</Text>
          <Text style={[styles.reinstallDescription, {color: colors.muted}]}>会删除 node_modules 和锁文件并重新安装，耗时较长</Text>
        </View>
        <Text style={[styles.reinstallAction, {color: colors.orange, backgroundColor: colors.orangeSoft}]}>立即重置</Text>
      </Pressable>

      {run ? (
        <View style={[styles.runBox, {backgroundColor: colors.surface, borderColor: colors.border}]}>
          <View style={styles.runHead}>
            <Text numberOfLines={1} style={[styles.runTitle, {color: colors.text}]}>
              {`${run.kind === 'install' ? '安装' : run.kind === 'update' ? '更新版本' : run.kind === 'reinstall' ? '重装' : '卸载'} ${run.target}`}
            </Text>
            {run.status === 'running' ? (
              <ActivityIndicator color={colors.accent} size='small' />
            ) : (
              <Text style={[styles.runState, {color: run.status === 'done' ? colors.success : colors.danger}]}>
                {run.status === 'done' ? '完成' : run.status === 'cancelled' ? '已终止' : '失败'}
              </Text>
            )}
            <Pressable
              accessibilityLabel={run.status === 'running' ? '终止任务' : '关闭日志'}
              onPress={() => (run.status === 'running' ? canceller.current?.abort() : setRun(null))}
              style={styles.runButton}>
              <X color={colors.muted} size={15} />
            </Pressable>
          </View>
          <LogConsole colors={colors} logs={run.logs} maxHeight={150} placeholder='等待输出…' />
        </View>
      ) : null}

      {deps === null && !listError ? (
        <View style={styles.state}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : listError ? (
        <View style={styles.state}>
          <Text style={[styles.stateText, {color: colors.danger}]}>{listError}</Text>
          <Pressable onPress={load} style={[styles.retry, {borderColor: colors.border}]}>
            <Text style={[styles.retryText, {color: colors.accent}]}>重试</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.listContent} keyboardShouldPersistTaps='handled'>
          <View style={styles.listHeader}>
            <View>
              <Text style={[styles.listTitle, {color: colors.text}]}>{`已安装依赖（${deps?.length ?? '—'}）`}</Text>
              <View style={styles.selectionActions}>
                <Pressable accessibilityLabel={allSelected ? '取消全选' : '全选'} onPress={toggleAll} style={styles.selectionButton}>
                  {allSelected ? <Check color={colors.accent} size={15} /> : <Square color={colors.muted} size={15} />}
                  <Text style={[styles.selectionButtonText, {color: colors.muted}]}>{allSelected ? '取消全选' : '全选'}</Text>
                </Pressable>
                {selectedNames.length ? <Text style={[styles.selectedCount, {color: colors.accent}]}>{`已选 ${selectedNames.length}`}</Text> : null}
                {selectedNames.length ? <Pressable accessibilityLabel='更新已选依赖到 latest' onPress={bulkUpdateLatest} style={[styles.bulkAction, {borderColor: colors.accent}]}><Text style={[styles.bulkActionText, {color: colors.accent}]}>更新</Text></Pressable> : null}
                {selectedNames.length ? <Pressable accessibilityLabel='卸载已选依赖' onPress={() => setBulkRemoveOpen(true)} style={[styles.bulkAction, {borderColor: colors.danger}]}><Text style={[styles.bulkActionText, {color: colors.danger}]}>卸载</Text></Pressable> : null}
              </View>
            </View>
          </View>
          {(deps ?? []).map(dep => (
            <View
              key={dep.name}
              style={[styles.card, {backgroundColor: colors.surface, borderColor: colors.border}]}>
              <Pressable accessibilityLabel={`选择 ${dep.name}`} onPress={() => !dep.core && toggleSelected(dep.name)} style={styles.checkbox}>
                {selectedNames.includes(dep.name) ? <View style={[styles.checkboxChecked, {backgroundColor: colors.accent, borderColor: colors.accent}]}><Check color='#FFFFFF' size={13} strokeWidth={3} /></View> : <Square color={dep.core ? colors.border : colors.muted} size={20} />}
              </Pressable>
              <View style={styles.cardCopy}>
                <Text numberOfLines={1} style={[styles.name, {color: colors.text}]}>
                  {dep.name}
                </Text>
                <View style={styles.metaRow}>
                  <View style={styles.specChip}>
                    <Text numberOfLines={1} style={[styles.specChipText, {color: colors.text}]}>{dep.installedVersion || dep.spec || '未声明'}</Text>
                  </View>
                  {dep.core ? (
                    <View style={[styles.tag, {backgroundColor: colors.orangeSoft}]}>
                      <Text style={[styles.tagText, {color: colors.orange}]}>核心</Text>
                    </View>
                  ) : null}
                  {dep.dev ? (
                    <View style={[styles.tag, {backgroundColor: colors.neutralSoft}]}>
                      <Text style={[styles.tagText, {color: colors.muted}]}>dev</Text>
                    </View>
                  ) : null}
                  {dep.installedVersion && dep.latestVersion && dep.installedVersion === dep.latestVersion ? (
                    <View style={[styles.tag, {backgroundColor: colors.successSoft}]}>
                      <Text style={[styles.tagText, {color: colors.success}]}>最新</Text>
                    </View>
                  ) : null}
                  {dep.installedVersion && dep.latestVersion && dep.installedVersion !== dep.latestVersion ? (
                    <View style={[styles.tag, {backgroundColor: colors.orangeSoft}]}>
                      <Text style={[styles.tagText, {color: colors.orange}]}>可更新</Text>
                    </View>
                  ) : null}
                </View>
              </View>
              <Pressable accessibilityLabel={`操作 ${dep.name}`} accessibilityRole='button' disabled={busy} onPress={() => setVersionTarget(dep)} style={[styles.updateButton, {borderColor: colors.accent}, busy && styles.disabled]}>
                <Text style={[styles.updateText, {color: colors.accent}]}>操作</Text>
              </Pressable>
            </View>
          ))}
          {deps && deps.length === 0 ? (
            <Text style={[styles.empty, {color: colors.muted}]}>package.json 里还没声明依赖</Text>
          ) : null}
          <Text style={[styles.footnote, {color: colors.muted}]}>
            {`应用版本更改后会立即安装；node-karin 换版本后要重启 Karin 才生效。版本列表缓存 1 小时，长按右上角刷新可清空缓存并重新获取。`}
          </Text>
        </ScrollView>
      )}

      <View pointerEvents='box-none' style={styles.fabLayer}>
        <Pressable
          accessibilityLabel='添加依赖'
          accessibilityRole='button'
          disabled={busy}
          onPress={() => {
            setAddPage('single');
            setAddPackage('');
            setAddVersion('');
            setBatchInput('');
            setAddLocation('dependencies');
            setAddModalOpen(true);
          }}
          style={[styles.fab, {backgroundColor: colors.accent}, busy && styles.disabled]}>
          <Plus color='#FFFFFF' size={25} strokeWidth={2.5} />
        </Pressable>
      </View>

      <Modal transparent visible={addModalOpen} animationType='fade' onRequestClose={() => setAddModalOpen(false)}>
        <KeyboardAvoidingView behavior='padding' style={styles.modalKeyboard}>
          <View style={styles.modalBackdrop}>
            <Pressable style={styles.modalDismiss} onPress={() => setAddModalOpen(false)} />
            <View style={[styles.addSheet, {backgroundColor: colors.surface}]}>
              <View style={styles.modalHeader}>
                <View style={styles.modalTitleCopy}>
                  <Text style={[styles.modalTitle, {color: colors.text}]}>添加依赖</Text>
                  <Text style={[styles.modalSubtitle, {color: colors.muted}]}>选择安装方式</Text>
                </View>
                <Pressable accessibilityLabel='关闭' onPress={() => setAddModalOpen(false)} style={styles.modalClose}><X color={colors.muted} size={19} /></Pressable>
              </View>
              <View style={[styles.pageTabs, {borderBottomColor: colors.border}]}>
                <Pressable onPress={() => setAddPage('single')} style={[styles.pageTab, addPage === 'single' && {borderBottomColor: colors.accent}]}><Text style={[styles.pageTabText, {color: addPage === 'single' ? colors.accent : colors.muted}]}>单个安装</Text></Pressable>
                <Pressable onPress={() => setAddPage('batch')} style={[styles.pageTab, addPage === 'batch' && {borderBottomColor: colors.accent}]}><Text style={[styles.pageTabText, {color: addPage === 'batch' ? colors.accent : colors.muted}]}>批量安装</Text></Pressable>
              </View>
              {addPage === 'single' ? <>
                <TextInput autoCapitalize='none' autoCorrect={false} autoFocus editable={!busy} onChangeText={setAddPackage} placeholder='包名（必填）' placeholderTextColor={colors.muted} style={[styles.formInput, {backgroundColor: colors.neutralSoft, borderColor: colors.border, color: colors.text}]} value={addPackage} />
                <TextInput autoCapitalize='none' autoCorrect={false} editable={!busy} onChangeText={setAddVersion} placeholder='版本号（留空为 latest）' placeholderTextColor={colors.muted} style={[styles.formInput, {backgroundColor: colors.neutralSoft, borderColor: colors.border, color: colors.text}]} value={addVersion} />
                <Text style={[styles.locationLabel, {color: colors.muted}]}>安装位置</Text>
                <View style={styles.locationRow}>
                  {([['dependencies', 'dependencies'], ['devDependencies', 'devDependencies'], ['optionalDependencies', 'optionalDependencies']] as const).map(([value, label]) => <Pressable key={value} onPress={() => setAddLocation(value)} style={[styles.locationOption, {borderColor: addLocation === value ? colors.accent : colors.border, backgroundColor: addLocation === value ? colors.accentSoft : colors.neutralSoft}]}><Text numberOfLines={1} style={[styles.locationText, {color: addLocation === value ? colors.accent : colors.text}]}>{label}</Text></Pressable>)}
                </View>
                <Pressable disabled={!addPackage.trim() || busy} onPress={submitAddDependency} style={[styles.installAllButton, {backgroundColor: colors.accent}, !addPackage.trim() && {backgroundColor: colors.accentSoft}, busy && styles.disabled]}><Text style={[primaryTextStyle, !addPackage.trim() && {color: colors.muted}]}>安装依赖</Text></Pressable>
              </> : <>
                <TextInput autoCapitalize='none' autoCorrect={false} autoFocus editable={!busy} multiline onChangeText={setBatchInput} placeholder='输入多个依赖，空格分隔' placeholderTextColor={colors.muted} style={[styles.batchInput, {backgroundColor: colors.neutralSoft, borderColor: colors.border, color: colors.text}]} value={batchInput} />
                <Text style={[styles.hint, {color: colors.muted}]}>依赖名用空格分隔，全部按 latest 安装</Text>
                <Pressable disabled={!batchInput.trim() || busy} onPress={submitBatchDependencies} style={[styles.installAllButton, {backgroundColor: colors.accent}, (!batchInput.trim() || busy) && styles.disabled]}><Text style={primaryTextStyle}>批量安装</Text></Pressable>
              </>}
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <ConfirmDialog
        colors={colors}
        title='卸载已选依赖'
        body={`将卸载已选的 ${selectedNames.length} 个依赖：${selectedNames.join('、')}`}
        confirmText='卸载全部'
        visible={bulkRemoveOpen}
        onClose={() => setBulkRemoveOpen(false)}
        onConfirm={bulkRemove}
      />
      <ConfirmDialog
        colors={colors}
        title='卸载依赖'
        body={`将从 Karin 目录卸载 ${removeTarget?.name ?? ''}${
          removeTarget?.core ? '。这是 Karin 核心依赖，通常不建议移除' : '。移除后可能影响 Karin 运行'
        }。`}
        confirmText='卸载'
        visible={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={confirmRemove}
      />
      <ConfirmDialog
        colors={colors}
        title='重置依赖环境'
        body='这不是刷新列表：将删除 Karin 目录中的 node_modules 和 pnpm-lock.yaml，再根据 package.json 执行 pnpm i。安装过程可能需要较长时间。'
        confirmText='重置环境'
        visible={reinstallConfirm}
        onClose={() => setReinstallConfirm(false)}
        onConfirm={confirmReinstall}
      />
      <DependencyVersionSheet
        colors={colors}
        dep={versionTarget}
        visible={versionTarget !== null}
        onClose={() => setVersionTarget(null)}
        onUpdateLatest={() => {
          if (versionTarget) updateLatest(versionTarget);
        }}
        onUninstall={() => {
          if (versionTarget && !versionTarget.core) {
            setRemoveTarget(versionTarget);
            setVersionTarget(null);
          }
        }}
        onClearCache={() => {
          clearPackageVersionCache();
        }}
        onSelect={spec => {
          if (versionTarget) applySpec(versionTarget, spec);
        }}
      />

    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  header: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth},
  headerButton: {width: 34, height: 34, alignItems: 'center', justifyContent: 'center'},
  headerSave: {minHeight: 30, borderRadius: 8, paddingHorizontal: 9, alignItems: 'center', justifyContent: 'center'},
  headerCopy: {flex: 1},
  headerTitle: {fontSize: 16, fontWeight: '800', letterSpacing: -0.2},
  headerPath: {fontFamily: 'monospace', fontSize: 10, marginTop: 2},
  reinstallCard: {flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 14, marginTop: 12, borderWidth: 1, borderRadius: 13, paddingHorizontal: 11, paddingVertical: 11},
  reinstallIcon: {width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center'},
  reinstallCopy: {flex: 1, gap: 2},
  reinstallTitle: {fontSize: 12.5, fontWeight: '800'},
  reinstallDescription: {fontSize: 10.5, lineHeight: 14},
  reinstallAction: {fontSize: 10.5, fontWeight: '800', paddingHorizontal: 7, paddingVertical: 5, borderRadius: 6},
  saveButton: {minHeight: 30, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center'},
  disabled: {opacity: 0.45},
  hint: {fontSize: 10.5, lineHeight: 15, paddingHorizontal: 10, paddingTop: 7},
  pendingBar: {flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 14, marginTop: 10, borderWidth: 1, borderRadius: 13, paddingHorizontal: 11, paddingVertical: 9},
  pendingCopy: {flex: 1, gap: 2},
  pendingTitle: {fontSize: 11.5, fontWeight: '800'},
  pendingHint: {fontSize: 10, lineHeight: 14},
  runBox: {marginHorizontal: 14, marginTop: 10, borderWidth: 1, borderRadius: 13, padding: 10},
  runHead: {flexDirection: 'row', alignItems: 'center', gap: 8},
  runTitle: {flex: 1, fontFamily: 'monospace', fontSize: 11},
  runState: {fontSize: 11, fontWeight: '700'},
  runButton: {width: 26, height: 26, alignItems: 'center', justifyContent: 'center'},
  state: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 20},
  stateText: {fontSize: 12, textAlign: 'center'},
  retry: {borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6},
  retryText: {fontSize: 12, fontWeight: '700'},
  listContent: {paddingHorizontal: 14, paddingTop: 13, paddingBottom: 96, gap: 8},
  listHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 2, paddingBottom: 2},
  listTitle: {fontSize: 13, fontWeight: '800', marginBottom: 2},
  selectionActions: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 7},
  selectionButton: {flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 28},
  selectionButtonText: {fontSize: 10.5, fontWeight: '700'},
  selectedCount: {fontSize: 10.5, fontWeight: '800'},
  bulkAction: {minHeight: 28, borderWidth: 1, borderRadius: 7, paddingHorizontal: 9, alignItems: 'center', justifyContent: 'center'},
  bulkActionText: {fontSize: 10.5, fontWeight: '800'},
  card: {flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 13, paddingHorizontal: 11, paddingVertical: 11},
  checkbox: {width: 24, height: 36, alignItems: 'center', justifyContent: 'center'},
  checkboxChecked: {width: 19, height: 19, borderWidth: 1, borderRadius: 5, alignItems: 'center', justifyContent: 'center'},
  cardCopy: {flex: 1, gap: 4},
  name: {fontFamily: 'monospace', fontSize: 12.5, fontWeight: '700'},
  metaRow: {flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap'},
  spec: {fontSize: 10},
  specChip: {maxWidth: 150, minHeight: 22, justifyContent: 'center'},
  specChipText: {fontFamily: 'monospace', fontSize: 11},
  tag: {borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1},
  tagText: {fontSize: 9, fontWeight: '700'},
  locked: {fontSize: 10, fontWeight: '700'},
  cardActions: {alignItems: 'flex-end', gap: 6},
  updateButton: {minWidth: 48, minHeight: 30, borderWidth: 1, borderRadius: 7, alignItems: 'center', justifyContent: 'center'},
  updateText: {fontSize: 11, fontWeight: '800'},
  removeButton: {flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 34, borderWidth: 1, borderRadius: 8, paddingHorizontal: 9},
  removeText: {fontSize: 11, fontWeight: '700'},
  empty: {textAlign: 'center', marginTop: 20},
  footnote: {fontSize: 10.5, lineHeight: 15, marginTop: 4},
  fabLayer: {...StyleSheet.absoluteFill, zIndex: 5},
  fab: {position: 'absolute', right: 18, bottom: 20, width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', elevation: 5, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: {width: 0, height: 3}},
  fabBadge: {position: 'absolute', right: -2, top: -2, minWidth: 19, height: 19, borderRadius: 10, alignItems: 'center', justifyContent: 'center'},
  fabBadgeText: {color: '#FFFFFF', fontSize: 11, fontWeight: '800'},
  modalKeyboard: {flex: 1, width: '100%'},
  modalBackdrop: {flex: 1, justifyContent: 'center', paddingHorizontal: 22, paddingVertical: 22, backgroundColor: 'rgba(0,0,0,0.48)'},
  modalDismiss: {...StyleSheet.absoluteFill},
  addSheet: {maxHeight: '90%', borderRadius: 18, padding: 16, paddingBottom: 20, gap: 8},
  modalHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4},
  modalTitleCopy: {gap: 2},
  modalTitle: {fontSize: 15, fontWeight: '800'},
  modalSubtitle: {fontSize: 10.5},
  modalClose: {width: 34, height: 34, alignItems: 'center', justifyContent: 'center'},
  pageTabs: {flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, marginBottom: 10},
  pageTab: {flex: 1, alignItems: 'center', paddingVertical: 8, borderBottomWidth: 2, borderBottomColor: 'transparent'},
  pageTabText: {fontSize: 12, fontWeight: '700'},
  formInput: {minHeight: 42, borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, fontSize: 13, fontFamily: 'monospace'},
  batchInput: {minHeight: 88, borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 10, fontSize: 13, fontFamily: 'monospace', textAlignVertical: 'top'},
  locationLabel: {fontSize: 11, fontWeight: '700', marginTop: 2},
  locationRow: {flexDirection: 'row', gap: 6},
  locationOption: {flex: 1, minHeight: 36, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4},
  locationText: {fontSize: 10, fontWeight: '700'},
  modalInputWrap: {minHeight: 44, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 10, paddingLeft: 11},
  modalInput: {flex: 1, minHeight: 42, paddingVertical: 0, fontFamily: 'monospace', fontSize: 12.5},
  addButton: {width: 36, height: 36, marginRight: 4, borderRadius: 9, alignItems: 'center', justifyContent: 'center'},
  pendingList: {gap: 6, marginTop: 3, maxHeight: 150},
  pendingItem: {minHeight: 34, borderRadius: 8, paddingLeft: 10, paddingRight: 5, flexDirection: 'row', alignItems: 'center', gap: 6},
  pendingItemText: {flex: 1, fontFamily: 'monospace', fontSize: 11.5},
  emptyPending: {fontSize: 11, textAlign: 'center', paddingVertical: 12},
  installAllButton: {minHeight: 42, marginTop: 5, marginBottom: 2, borderRadius: 10, alignItems: 'center', justifyContent: 'center'},
});
