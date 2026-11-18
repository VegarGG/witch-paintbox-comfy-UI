import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = name => readFile(path.join(root, name), 'utf8');
const modules = ['comfy-types', 'comfy-workflow', 'comfyui', 'comfy-config', 'direct-image', 'direct-image-runner', 'direct-image-view'];
const required = ['README.md', 'README-zh.md', 'CHANGELOG.md', 'NEXT.md', 'BASELINE-2026-11-17.md', 'qa/gaps.md', 'qa/run-all.sh',
  'workflows/README.md', 'workflows/dirty-moss-v2.ui.json', 'workflows/dirty-moss-v2.api.json', 'workflows/dirty-moss-v2.bindings.json',
  ...['T-01/workflow.test.mjs', 'T-01/protocol.test.mjs', 'T-01/run.sh', 'T-02/settings.test.mjs', 'T-02/direct.test.mjs', 'T-02/run.sh', 'T-03/delivery.test.mjs', 'T-03/run.sh'].map(name => `qa/${name}`),
  ...modules.flatMap(name => [`src/${name}.ts`, `dist/${name}.js`])];
function requireDeliverables(available) {
  const present = new Set(available), missing = required.filter(name => !present.has(name));
  assert.deepEqual(missing, [], `missing experiment deliverables: ${missing.join(', ')}`);
}

test('every declared experiment source, real build artifact, workflow, QA entry and user document exists', async () => {
  const available = [];
  for (const name of required) {
    try { const info = await stat(path.join(root, name)); if (info.isFile() && info.size > 0) available.push(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  requireDeliverables(available);
});

test('the delivery assertion actually fails for every individually missing required file', () => {
  requireDeliverables(required);
  for (const name of required) assert.throws(() => requireDeliverables(required.filter(item => item !== name)), /missing experiment deliverables/);
});

test('default verification builds before QA, retains the original suites, and adds no runtime dependency', async () => {
  const pkg = JSON.parse(await text('package.json'));
  const buildAt = pkg.scripts.test.indexOf('node_modules/typescript/bin/tsc'), qaAt = pkg.scripts.test.indexOf('qa/run-all.sh');
  assert.ok(buildAt >= 0 && qaAt > buildAt, 'default test must invoke the real compiler before QA');
  assert.doesNotMatch(pkg.scripts.test, /\bnpm\b/, 'the bundled Node+pnpm runtime does not include npm; do not recursively require it');
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
  assert.deepEqual(pkg.devDependencies, { typescript: '~5.8.3' });
  const runner = await text('qa/run-all.sh');
  for (const name of ['image-workflow', 'openai-image-26', 'illustration-selection']) assert.ok(runner.includes(`tests/${name}.test.mjs`));
  for (const name of ['T-01/workflow', 'T-01/protocol', 'T-02/settings', 'T-02/direct', 'T-03/delivery']) assert.ok(runner.includes(`qa/${name}.test.mjs`));
  assert.match(runner, /typescript\/bin\/tsc/); assert.match(runner, /set -euo pipefail/);
});

test('delivered dist is byte-for-byte the real strict project TypeScript output, not hand-written or stale', async () => {
  const configPath = path.join(root, 'tsconfig.json');
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile); assert.equal(loaded.error, undefined);
  const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
  assert.equal(config.options.strict, true); assert.equal(config.options.noEmitOnError, true);
  const program = ts.createProgram(config.fileNames, config.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  const outputs = new Map();
  const result = program.emit(undefined, (name, content) => outputs.set(name, content));
  assert.equal(result.emitSkipped, false); assert.ok(outputs.size >= modules.length);
  for (const [name, content] of outputs) assert.equal(await readFile(name, 'utf8'), content, `stale build artifact: ${path.relative(root, name)}`);
});

test('user docs distinguish local install plans, live-test gaps, CPU enhancer observations and rollback', async () => {
  const guide = await text('README-zh.md'), gaps = await text('qa/gaps.md'), next = await text('NEXT.md');
  for (const marker of ['BASELINE-2026-11-17.md', '回滚', 'CORS', 'sessionStorage', 'TextGenerate', '6000', '不改聊天']) assert.ok(guide.includes(marker), `guide must discuss ${marker}`);
  for (const marker of ['未测', '峰值', 'Tauri', '独立', '中止']) assert.ok(gaps.includes(marker), `gaps must discuss ${marker}`);
  assert.ok(next.includes('唯一续接入口'));
  const readme = await text('README.md'); assert.match(readme, /README-zh\.md/); assert.match(readme, /NEXT\.md/);
});

test('Tauri installation uses the user fork Git URL only after user review and merge to main', async () => {
  const guide = await text('README-zh.md'), readme = await text('README.md');
  assert.ok(guide.includes('https://github.com/VegarGG/witch-paintbox-comfy-UI'));
  assert.match(guide, /审核.*合并/s); assert.match(guide, /分支或标签名称.*main/s);
  assert.match(guide, /不要.*手工复制/s);
  assert.ok(!guide.includes('使用完成构建的本地内容更新'));
  assert.match(readme, /PR.*审核.*合并/s);
});

test('published experiment documents contain no private host paths or links to ignored local controls', async () => {
  for (const file of ['README.md', 'README-zh.md', 'CHANGELOG.md', 'NEXT.md', 'BASELINE-2026-11-17.md', 'qa/gaps.md', 'workflows/README.md']) {
    const content = await text(file);
    assert.doesNotMatch(content, /\/(?:Users|var\/folders|private\/var)\//, `${file}: private host path`);
    assert.doesNotMatch(content, /\]\(<?(?:\/|(?:\.\.\/)?\.dsh-crew\/)/, `${file}: non-portable local link`);
  }
  assert.match(await text('.gitignore'), /^\.dsh-crew\/$/m);
});

test('new experiment documentation links resolve inside the repository without requiring host-only model paths', async () => {
  for (const file of ['README-zh.md', 'BASELINE-2026-11-17.md', 'qa/gaps.md', 'workflows/README.md']) {
    const content = await text(file);
    for (const match of content.matchAll(/\]\(<?([^\s)>]+)>?\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue;
      assert.ok((await stat(path.resolve(root, path.dirname(file), decodeURIComponent(target)))).isFile(), `${file} has broken link ${target}`);
    }
  }
});
