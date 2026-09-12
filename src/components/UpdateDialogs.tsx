import React from 'react';
import ConfirmDialog from './ConfirmDialog';
import {Colors} from '../theme/colors';
import type {UpdateFlow} from '../hooks/useUpdateFlow';

type Props = {
  colors: Colors;
  flow: UpdateFlow;
};

/** 更新流程的三个弹窗：发现新版本 / 下载完成 / 需要安装权限，设置页与关于页共用。 */
export default function UpdateDialogs({colors, flow}: Props) {
  const {update, dialog} = flow;
  return (
    <>
      <ConfirmDialog
        visible={dialog === 'download'}
        title={update.release ? `发现新版本 v${update.release.version}` : '发现新版本'}
        body={`${flow.releaseNotes}\n\n${flow.downloadSummary}\n下载到应用私有目录，完成后可选择是否立即安装。`}
        confirmText={update.partial ? '继续下载' : '开始下载'}
        tone="primary"
        colors={colors}
        onConfirm={flow.confirmDownload}
        onClose={() => flow.setDialog(null)}
      />
      <ConfirmDialog
        visible={dialog === 'install'}
        title="下载完成"
        body="是否立即安装？安装前会先停止 Karin，并让 proot 容器优雅退出（超时后强杀），随后拉起系统安装器。"
        confirmText="立即安装"
        tone="primary"
        colors={colors}
        onConfirm={flow.confirmInstall}
        onClose={() => flow.setDialog(null)}
      />
      <ConfirmDialog
        visible={dialog === 'permission'}
        title="需要安装权限"
        body="系统要求先允许本应用「安装未知应用」。点「去设置」打开授权页并允许，返回后会自动继续安装。"
        confirmText="去设置"
        tone="primary"
        colors={colors}
        onConfirm={flow.confirmPermission}
        onClose={() => flow.setDialog(null)}
      />
    </>
  );
}
