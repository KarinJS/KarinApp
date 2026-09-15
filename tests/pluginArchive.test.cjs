/* eslint-env node, es2022 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function setup(overrides = {}) {
  const calls = [];
  const info = {name: '@scope/karin-plugin-a', directoryName: 'karin-plugin-a', conflict: false};
  const bridge = {
    canImportKarinPluginArchive: () => true,
    pickKarinPluginArchive: async () => 'content://plugin.zip',
    inspectKarinPluginArchive: async () => info,
    importKarinPluginArchive: async (...args) => { calls.push(['import', ...args]); return info; },
    cancelKarinPluginImport: async id => { calls.push(['cancel', id]); return true; },
    finishKarinPluginImport: async id => { calls.push(['finish', id]); },
    ...overrides,
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/services/pluginArchiveImport.ts'), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const module = {exports: {}};
  vm.runInNewContext(code, {module, exports: module.exports, require: () => bridge, AbortController});
  const controller = new AbortController();
  const logs = [];
  const names = [];
  const run = (onWarning = async () => true) => module.exports.importLocalPluginArchive({
    signal: controller.signal, onLog: line => logs.push(line), onName: name => names.push(name), onWarning,
  });
  return {calls, controller, info, logs, names, run};
}

test('导入使用规范化后的目录和同一个原生任务 ID', async () => {
  let inspectedId;
  const s = setup({inspectKarinPluginArchive: async (_uri, id) => { inspectedId = id; return s.info; }});
  const result = await s.run();
  assert.equal(result.directoryName, 'karin-plugin-a');
  assert.deepEqual(s.names, ['@scope/karin-plugin-a']);
  assert.equal(s.calls.find(c => c[0] === 'import')[3], inspectedId);
  assert.ok(s.logs.some(line => line.includes('plugins/karin-plugin-a')));
});

test('警告等待确认期间不会解压，确认后才覆盖', async () => {
  const s = setup();
  s.info.conflict = true;
  let decide;
  const job = s.run(warning => {
    assert.match(warning.message, /karin-plugin-a.*是否覆盖/);
    return new Promise(resolve => { decide = resolve; });
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.calls.filter(c => c[0] === 'import').length, 0);
  decide(true);
  await job;
  assert.equal(s.calls.find(c => c[0] === 'import')[2], true);
});

test('拒绝覆盖及取消文件选择都不写插件目录', async () => {
  const s = setup();
  s.info.conflict = true;
  assert.equal(await s.run(async () => false), null);
  assert.equal(s.calls.filter(c => c[0] === 'import').length, 0);
  const picker = setup({pickKarinPluginArchive: async () => null});
  assert.equal(await picker.run(), null);
  assert.equal(picker.calls.filter(c => c[0] === 'import').length, 0);
});

test('package.json 校验失败不会进入解压', async () => {
  const s = setup({inspectKarinPluginArchive: async () => { throw new Error('根目录缺少 package.json'); }});
  await assert.rejects(s.run(), /package.json/);
  assert.equal(s.calls.filter(c => c[0] === 'import').length, 0);
});

test('校验过程中终止，通知原生并阻止后续解压', async () => {
  let finishInspect;
  const s = setup({inspectKarinPluginArchive: () => new Promise(resolve => { finishInspect = resolve; })});
  const job = s.run();
  await new Promise(resolve => setImmediate(resolve));
  s.controller.abort();
  finishInspect(s.info);
  await assert.rejects(job, /任务已终止/);
  assert.equal(s.calls.filter(c => c[0] === 'cancel').length, 1);
  assert.equal(s.calls.filter(c => c[0] === 'import').length, 0);
});

test('解压中终止会传递给正在执行的原生任务', async () => {
  let failImport;
  let importedId;
  const s = setup({importKarinPluginArchive: (_uri, _overwrite, id) => {
    importedId = id;
    return new Promise((_resolve, reject) => { failImport = reject; });
  }});
  const job = s.run();
  await new Promise(resolve => setImmediate(resolve));
  s.controller.abort();
  failImport(new Error('任务已终止'));
  await assert.rejects(job, /任务已终止/);
  assert.equal(s.calls.find(c => c[0] === 'cancel')[1], importedId);
});

function loadFileImport(native) {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/appPluginImport.ts'), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const module = {exports: {}};
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: () => ({NativeModules: {KarinAppPluginImport: native}}),
  });
  return module.exports.importLocalAppPlugin;
}

test('单文件导入也传递取消，并等待原生返回后释放任务', async () => {
  const calls = [];
  let finishCopy;
  const run = loadFileImport({
    pickFile: () => { throw new Error('不应使用不可终止的旧接口'); },
    pickFileCancellable: (_directory, id) => {
      calls.push(['pick', id]);
      return new Promise(resolve => { finishCopy = resolve; });
    },
    cancelImport: async id => { calls.push(['cancel', id]); return true; },
    finishImport: async id => { calls.push(['finish', id]); return true; },
  });
  const controller = new AbortController();
  const job = run('root/karin/plugins/karin-plugin-example', controller.signal);
  controller.abort();
  assert.deepEqual(calls.map(c => c[0]), ['pick', 'cancel']);
  finishCopy(null);
  await assert.rejects(job, /任务已终止/);
  assert.deepEqual(calls.map(c => c[0]), ['pick', 'cancel', 'finish']);
  assert.ok(calls.every(c => c[1] === calls[0][1]));
});

test('ZIP 成功和失败均清理原生缓存', async () => {
  const success = setup();
  await success.run();
  assert.equal(success.calls.at(-1)[0], 'finish');
  const failed = setup({inspectKarinPluginArchive: async () => { throw new Error('格式错误'); }});
  await assert.rejects(failed.run(), /格式错误/);
  assert.equal(failed.calls.at(-1)[0], 'finish');
});
