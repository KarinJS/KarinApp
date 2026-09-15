/* eslint-env node, es2022 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {test} = require('node:test');
const ts = require('typescript');
const React = require('react');
const {act, create} = require('react-test-renderer');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const loadHook = () => {
  const sourcePath = path.resolve(__dirname, '../src/hooks/usePluginTasks.ts');
  const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => originalRequire(name);
  loaded._compile(compiled, sourcePath);
  return loaded.exports.usePluginTasks;
};

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};

const mountTasks = async () => {
  const usePluginTasks = loadHook();
  let manager;
  let renderer;
  function Harness() {
    manager = usePluginTasks();
    return null;
  }
  await act(async () => { renderer = create(React.createElement(Harness)); });
  return {
    get manager() { return manager; },
    async dispose() { await act(async () => renderer.unmount()); },
  };
};

test('警告只在点击后显示自定义弹窗状态，确认后继续并保留任务日志', async () => {
  const app = await mountTasks();
  let task;
  let accepted;
  await act(async () => {
    task = app.manager.runTask('karin-plugin-a', 'install', async ({onWarning, onLog, setName}) => {
      setName('@scope/karin-plugin-a');
      accepted = await onWarning({title: '插件已存在', message: '目录已存在，是否覆盖？'});
      if (accepted) onLog('正在解压插件');
    });
  });
  const id = app.manager.taskList[0].id;
  assert.equal(app.manager.tasks[id].status, 'warning');
  assert.equal(app.manager.tasks[id].name, '@scope/karin-plugin-a');
  assert.equal(app.manager.warningDialog, null);
  assert.match(app.manager.tasks[id].logs.join('\n'), /警告：.*是否覆盖/);
  await act(async () => { app.manager.showWarning(id); app.manager.showWarning(id); });
  assert.equal(app.manager.warningDialog?.taskId, id);
  assert.equal(app.manager.warningDialog?.warning.message, '目录已存在，是否覆盖？');
  await act(async () => { app.manager.resolveWarning(id, true); await task; });
  assert.equal(accepted, true);
  assert.equal(app.manager.tasks[id].status, 'completed');
  assert.deepEqual(app.manager.tasks[id].logs.slice(-3), ['已确认，继续执行', '正在解压插件', '任务已完成']);
  await app.dispose();
});

test('警告选择否会中止任务并释放等待', async () => {
  const app = await mountTasks();
  let task;
  let accepted;
  let signal;
  await act(async () => {
    task = app.manager.runTask('karin-plugin-a', 'install', async runner => {
      signal = runner.signal;
      accepted = await runner.onWarning('是否覆盖？');
    });
  });
  const id = app.manager.taskList[0].id;
  await act(async () => { app.manager.showWarning(id); });
  await act(async () => { app.manager.resolveWarning(id, false); await task; });
  assert.equal(accepted, false);
  assert.equal(signal.aborted, true);
  assert.equal(app.manager.tasks[id].status, 'cancelled');
  assert.equal(app.manager.tasks[id].logs.at(-1), '任务已终止');
  await app.dispose();
});

test('停止等待中的任务后，迟到的确认不能恢复任务且清理期间仍禁止并发', async () => {
  const app = await mountTasks();
  const cleanup = deferred();
  let task;
  let accepted;
  let signal;
  await act(async () => {
    task = app.manager.runTask('karin-plugin-a', 'install', async runner => {
      signal = runner.signal;
      accepted = await runner.onWarning('是否覆盖？');
      await cleanup.promise;
      assert.equal(await runner.onWarning('迟到的警告'), false);
    });
  });
  const id = app.manager.taskList[0].id;
  await act(async () => { app.manager.showWarning(id); });
  await act(async () => { app.manager.stopTask(id); });
  assert.equal(signal.aborted, true);
  assert.equal(accepted, false);
  assert.equal(app.manager.tasks[id].cancelling, true);
  assert.equal(app.manager.running, true);
  await act(async () => { app.manager.resolveWarning(id, true); });
  assert.equal(app.manager.tasks[id].warning, undefined);
  assert.equal(app.manager.tasks[id].cancelling, true);
  let concurrentRan = false;
  assert.equal(await app.manager.runTask('karin-plugin-b', 'install', async () => { concurrentRan = true; }), id);
  assert.equal(concurrentRan, false);
  await act(async () => { cleanup.resolve(); await task; });
  assert.equal(app.manager.tasks[id].status, 'cancelled');
  assert.equal(app.manager.tasks[id].cancelling, false);
  assert.equal(app.manager.running, false);
  assert.equal(app.manager.tasks[id].logs.some(line => line === '已确认，继续执行'), false);
  await app.dispose();
});

test('同名重复安装有独立 ID，进行中复用现有任务', async () => {
  const app = await mountTasks();
  let firstId;
  let secondId;
  await act(async () => { firstId = await app.manager.runTask('karin-plugin-a', 'install', async () => {}); });
  await act(async () => { secondId = await app.manager.runTask('karin-plugin-a', 'install', async () => {}); });
  assert.notEqual(firstId, secondId);
  assert.equal(app.manager.taskList.length, 2);
  const finish = deferred();
  let thirdTask;
  await act(async () => { thirdTask = app.manager.runTask('karin-plugin-a', 'install', () => finish.promise); });
  const activeId = app.manager.taskList.find(item => item.status === 'running').id;
  let ran = false;
  assert.equal(await app.manager.runTask('karin-plugin-b', 'install', async () => { ran = true; }), activeId);
  assert.equal(ran, false);
  assert.equal(app.manager.taskList.length, 3);
  await act(async () => { finish.resolve(); await thirdTask; });
  await app.dispose();
});

test('只允许删除已完成或已终止的任务，失败、警告和运行中保留', async () => {
  const app = await mountTasks();
  let completed;
  let failed;
  let cancelled;
  await act(async () => { completed = await app.manager.runTask('完成', 'install', async () => {}); });
  await act(async () => { failed = await app.manager.runTask('失败', 'install', async () => { throw new Error('无效压缩包'); }); });
  await act(async () => { cancelled = await app.manager.runTask('终止', 'install', async ({cancel}) => { cancel(); }); });
  const finish = deferred();
  let warningTask;
  await act(async () => {
    warningTask = app.manager.runTask('警告', 'install', async ({onWarning}) => {
      await onWarning('是否覆盖？');
      await finish.promise;
    });
  });
  const warningId = app.manager.taskList.find(item => item.status === 'warning').id;
  await act(async () => { [completed, failed, cancelled, warningId].forEach(id => app.manager.removeTask(id)); });
  assert.equal(app.manager.tasks[completed], undefined);
  assert.equal(app.manager.tasks[failed].status, 'failed');
  assert.equal(app.manager.tasks[cancelled], undefined);
  assert.equal(app.manager.tasks[warningId].status, 'warning');
  await act(async () => { app.manager.showWarning(warningId); });
  await act(async () => { app.manager.resolveWarning(warningId, true); });
  await act(async () => { app.manager.removeTask(warningId); });
  assert.equal(app.manager.tasks[warningId].status, 'running');
  await act(async () => { finish.resolve(); await warningTask; });
  await app.dispose();
});
