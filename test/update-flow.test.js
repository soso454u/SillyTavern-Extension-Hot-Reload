import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as core from '../lib/core.js';

// Exercise the actual orchestrator with host/network boundaries replaced.
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const updateSource = source.slice(source.indexOf('async function updateOne('), source.indexOf('\nasync function updateAllVisible('));

function fixture(overrides = {}) {
    const calls = [];
    const oldManifest = { js: 'index.js', version: '1' };
    const nextManifest = { ...oldManifest, version: '2' };
    const context = {
        ...core, structuredClone, LOG_PREFIX: '[test]', console: { error() {}, warn() {} },
        settings: { mode: 'force', seamlessFallback: true, reloadStyles: false },
        runtimeManifests: new Map(), runtimeModules: new Map(), runtimeGraphs: new Map(), pendingApplications: new Map(),
        updating: new Set(), extensionsApi: { extensionTypes: {} }, extension_settings: {},
        notify: (...args) => calls.push(['notify', ...args]), log() {},
        getManifest: async () => context.runtimeManifests.get('third-party/Demo') ?? oldManifest,
        importExtensionModule: async (_id, _manifest, token) => {
            calls.push(['import', token]);
            return { version: token ? 2 : 1 };
        },
        assessManagedRuntime: async () => ({ eligible: false }),
        updateRepository: async () => ({ isUpToDate: false, shortCommitHash: 'abc' }),
        evictExtensionAssetCaches: async () => {}, fetchFreshManifest: async () => nextManifest,
        inspectExtensionEntry: async () => ({ risks: [], localDependencies: ['./child.js'] }),
        prepareFreshGraph: async () => { calls.push(['prepare']); return null; },
        warmExtensionAssets: async () => { calls.push(['warm']); },
        promiseWithTimeout: async (promise) => promise,
        invokeManifestHook: async (module, _manifest, hook) => { calls.push(['hook', module.version, hook]); },
        runtimeSupervisor: {
            getSnapshot: () => ({ activeResources: 3 }),
            dispose: async () => { calls.push(['dispose']); return { complete: true }; }, discard() {},
        },
        updateManagerRow: () => {},
        ...overrides,
    };
    const update = vm.runInNewContext(`(${updateSource})`, context);
    return { context, calls, update, oldManifest, nextManifest };
}

test('force mode bypasses multi-file fallback, prepares first and cleans tracked resources', async () => {
    const f = fixture();
    const result = await f.update('Demo');
    assert.equal(result.status, 'force-reloaded');
    assert.equal(result.allowAutoRestart, false);
    const prepare = f.calls.findIndex(([name]) => name === 'prepare');
    const dispose = f.calls.findIndex(([name]) => name === 'dispose');
    const freshImport = f.calls.findIndex(([name, token]) => name === 'import' && token);
    assert.ok(prepare < dispose && dispose < freshImport);
    assert.equal(f.context.runtimeModules.get('third-party/Demo').version, 2);
    assert.equal(f.context.pendingApplications.size, 0);
});

test('graph preparation failure preserves old runtime and can retry an already updated repository', async () => {
    const f = fixture({ prepareFreshGraph: async () => { throw new Error('unsupported cycle'); } });
    let result = await f.update('Demo');
    assert.equal(result.status, 'needs-page-reload');
    assert.equal(core.shouldAutoRestartUpdate(result), false);
    assert.equal(f.calls.some(([name]) => name === 'dispose'), false);
    assert.equal(f.context.runtimeManifests.get('third-party/Demo').version, '1');
    assert.equal(f.context.pendingApplications.size, 1);
    f.context.prepareFreshGraph = async () => null;
    f.context.updateRepository = async () => ({ isUpToDate: true });
    result = await f.update('Demo');
    assert.equal(result.status, 'force-reloaded');
    assert.equal(f.context.pendingApplications.size, 0);
});

test('manifest structure changes in force mode never qualify for automatic navigation', async () => {
    const f = fixture({ fetchFreshManifest: async () => ({ js: 'other.js', version: '2' }) });
    const result = await f.update('Demo');
    assert.equal(result.status, 'needs-page-reload');
    assert.equal(core.shouldAutoRestartUpdate(result), false);
    assert.equal(f.calls.some(([name]) => ['dispose', 'warm', 'prepare'].includes(name)), false);
});

test('failed activation in force mode reports partial runtime changes without automatic refresh', async () => {
    const f = fixture({ invokeManifestHook: async () => { throw new Error('activation failed'); } });
    const result = await f.update('Demo');
    assert.equal(result.recoveryReason, 'runtime-touched');
    assert.equal(core.shouldAutoRestartUpdate(result), false);
    assert.equal(f.context.runtimeManifests.get('third-party/Demo').version, '1');
    const count = f.calls.length;
    const retry = await f.update('Demo', null, { quiet: true });
    assert.equal(core.shouldAutoRestartUpdate(retry), false);
    assert.equal(f.calls.length, count);
});

test('uses the currently activated namespace when updating or deleting a hot-reloaded extension', async () => {
    const start = source.indexOf('async function importExtensionModule(');
    const fn = source.slice(start, source.indexOf('\nasync function prepareFreshGraph(', start));
    const live = { dispose() {} };
    const runtimeModules = new Map([['third-party/Demo', live]]);
    const getModule = vm.runInNewContext(`(${fn})`, { runtimeModules });
    assert.equal(await getModule('third-party/Demo', { js: 'index.js' }), live);
});

test('safe mode retains its verified restart fallback and force bulk override is isolated', async () => {
    const f = fixture({ settings: { mode: 'safe', seamlessFallback: true } });
    const safe = await f.update('Demo');
    assert.equal(core.shouldAutoRestartUpdate(safe), true);
    const forced = await f.update('Demo', null, { mode: 'force' });
    assert.equal(forced.status, 'force-reloaded');
    assert.equal(f.context.settings.mode, 'safe');
});

test('disabled extensions update files without importing scripts or preparing graphs', async () => {
    const f = fixture({ extension_settings: { disabledExtensions: ['third-party/Demo'] } });
    const result = await f.update('Demo');
    assert.equal(result.status, 'updated-disabled');
    assert.equal(f.calls.some(([name]) => ['import', 'prepare', 'dispose'].includes(name)), false);
});

test('force batch keeps one policy and never schedules restart for unapplied updates', async () => {
    const start = source.indexOf('async function updateAllVisible(');
    const fn = source.slice(start, source.indexOf('\nfunction scheduleEnsureUi(', start));
    const calls = [];
    const button = { disabled: false, querySelector: () => null };
    const context = {
        settings: { mode: 'safe', seamlessFallback: true }, shouldAutoRestartUpdate: core.shouldAutoRestartUpdate,
        document: { querySelectorAll: () => [{ dataset: { name: 'one' } }, { dataset: { name: 'two' } }] },
        updateOne: async (_id, _button, options) => {
            calls.push(options.mode);
            return { status: 'needs-page-reload', updateVerified: true, allowAutoRestart: false };
        },
        notify: (_type, message) => calls.push(message),
        requestSeamlessRestart: async () => { throw new Error('Unexpected navigation'); },
    };
    const updateAll = vm.runInNewContext(`(${fn})`, context);
    await updateAll(button, { mode: 'force' });
    assert.deepEqual(calls.slice(0, 2), ['force', 'force']);
    assert.match(calls[2], /2 个未能热应用/);
    assert.equal(button.disabled, false);
});
