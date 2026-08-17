import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HOT_RELOAD_MODE,
    buildRestartNavigationUrl,
    buildAssetUrl,
    classifyScriptReload,
    findCleanupHook,
    findDeletionHook,
    findLocalModuleDependencies,
    findManagedRuntimeRisks,
    findManifestStructureChanges,
    hasSelfManagedModules,
    isSameAsset,
    isUpdateAllLabel,
    normalizeRepositoryUpdateResult,
    normalizeDrawerTitle,
    normalizeExternalId,
    normalizeRestartPath,
    resolveExtensionType,
    shouldAutoRestartUpdate,
    stripRestartNavigationToken,
    toInternalId,
    withCacheBuster,
} from '../lib/core.js';

test('normalizes SillyTavern extension ids', () => {
    assert.equal(normalizeExternalId('/Demo'), '/Demo');
    assert.equal(normalizeExternalId('Demo'), '/Demo');
    assert.equal(normalizeExternalId('third-party/Demo'), '/Demo');
    assert.equal(toInternalId('/Demo'), 'third-party/Demo');
    assert.throws(() => normalizeExternalId('../Demo'));
});

test('normalizes extension drawer titles for restart matching', () => {
    assert.equal(normalizeDrawerTitle('  酒馆助手   New! '), '酒馆助手');
    assert.equal(normalizeDrawerTitle('Selene 音乐播放器'), 'Selene 音乐播放器');
    assert.equal(normalizeDrawerTitle('New Character Tools'), 'New Character Tools');
});

test('recognizes native and translated update-all toolbar labels', () => {
    assert.equal(isUpdateAllLabel('Update all'), true);
    assert.equal(isUpdateAllLabel(' [title]Update   all '), true);
    assert.equal(isUpdateAllLabel('更新全部'), true);
    assert.equal(isUpdateAllLabel('全部更新'), true);
    assert.equal(isUpdateAllLabel('Update enabled'), false);
    assert.equal(isUpdateAllLabel('Close'), false);
});

test('normalizes native-host update results and rejects ambiguous responses', () => {
    assert.deepEqual(normalizeRepositoryUpdateResult({
        isUpToDate: false,
        shortCommitHash: 'abc1234',
    }), {
        isUpToDate: false,
        shortCommitHash: 'abc1234',
    });
    assert.equal(normalizeRepositoryUpdateResult({
        is_up_to_date: true,
        short_commit_hash: 'def5678',
    }).isUpToDate, true);
    assert.throws(() => normalizeRepositoryUpdateResult({ shortCommitHash: 'abc1234' }));
    assert.throws(() => normalizeRepositoryUpdateResult(null));
});

test('allows automatic restart only after a verified update', () => {
    assert.equal(shouldAutoRestartUpdate({ status: 'needs-page-reload', updateVerified: true }), true);
    assert.equal(shouldAutoRestartUpdate({ status: 'needs-page-reload', updateVerified: false }), false);
    assert.equal(shouldAutoRestartUpdate({ status: 'failed', updateVerified: true }), false);
});

test('uses a one-shot navigation token without changing restart-state identity', () => {
    const original = 'https://tauri.localhost/?foo=1#chat';
    const restartUrl = buildRestartNavigationUrl(original, 'token-1');
    assert.equal(restartUrl, 'https://tauri.localhost/?foo=1&st_hot_restart=token-1#chat');
    assert.equal(normalizeRestartPath(restartUrl), '/?foo=1#chat');
    assert.equal(stripRestartNavigationToken(restartUrl), original);
});

test('resolves local and global extension types', () => {
    const types = { 'third-party/Demo': 'local', 'third-party/Other': 'global' };
    assert.equal(resolveExtensionType(types, '/Demo'), 'local');
    assert.equal(resolveExtensionType(types, 'Other'), 'global');
    assert.equal(resolveExtensionType(types, 'Missing'), '');
});

test('builds encoded same-origin asset URLs and rejects traversal', () => {
    assert.equal(
        buildAssetUrl('third-party/My Extension', 'dist/main.js'),
        '/scripts/extensions/third-party/My%20Extension/dist/main.js',
    );
    assert.throws(() => buildAssetUrl('third-party/Demo', '../script.js'));
});

test('adds a deterministic cache-busting parameter', () => {
    assert.equal(withCacheBuster('/x.js?lang=zh', 'abc'), '/x.js?lang=zh&st_hot_reload=abc');
});

test('detects local static, re-exported, and dynamic module dependencies', () => {
    const source = `
        import '../../../extensions.js';
        import { helper } from './lib/helper.js?v=2';
        export { value } from './feature.js';
        const lazy = import('/scripts/extensions/third-party/Demo/lazy.js');
        const packageModule = import('some-package');
    `;
    assert.deepEqual(findLocalModuleDependencies(
        source,
        'http://localhost/scripts/extensions/third-party/Demo/index.js?hot=1',
        'http://localhost/scripts/extensions/third-party/Demo/',
    ), ['./lib/helper.js?v=2', './feature.js', '/scripts/extensions/third-party/Demo/lazy.js']);
});

test('detects local URL and worker runtime resources', () => {
    const source = `
        const workerUrl = new URL('./worker.js', import.meta.url);
        const worker = new Worker('./direct-worker.js', { type: 'module' });
        const shared = new SharedWorker('/scripts/extensions/third-party/Demo/shared.js');
        const remote = new Worker('https://example.com/remote.js');
    `;
    assert.deepEqual(findLocalModuleDependencies(
        source,
        'http://localhost/scripts/extensions/third-party/Demo/index.js',
        'http://localhost/scripts/extensions/third-party/Demo/',
    ), ['./worker.js', './direct-worker.js', '/scripts/extensions/third-party/Demo/shared.js']);
});

test('detects lifecycle manifest changes but ignores cosmetic metadata', () => {
    const previous = {
        display_name: 'Demo',
        version: '1.0.0',
        js: 'index.js',
        hooks: { activate: 'activate', disable: 'disable' },
        requires: ['vectors'],
    };
    assert.deepEqual(findManifestStructureChanges(previous, {
        ...previous,
        display_name: 'Demo renamed',
        version: '1.1.0',
        hooks: { disable: 'disable', activate: 'activate' },
    }), []);
    assert.deepEqual(findManifestStructureChanges(previous, {
        ...previous,
        js: 'dist/index.js',
        requires: ['vectors', 'chromadb'],
    }), ['js', 'requires']);
});

test('detects runtime effects that managed cleanup cannot safely reverse', () => {
    const source = `
        window.sharedApi = patchedApi;
        HTMLElement.prototype.focus = replacement;
        panel.innerHTML = html;
        document.body.classList.add('demo-active');
        import(runtimeUrl);
        customElements.define('demo-panel', DemoPanel);
    `;
    assert.deepEqual(findManagedRuntimeRisks(source), [
        'global-assignment',
        'prototype-mutation',
        'html-replacement',
        'existing-dom-mutation',
        'opaque-dynamic-import',
        'custom-element',
    ]);
    assert.deepEqual(findManagedRuntimeRisks('document.addEventListener("click", handler);'), []);
});

test('recognizes explicit self-managed module declarations', () => {
    assert.equal(hasSelfManagedModules({ extension_hot_reload: { self_managed_modules: true } }), true);
    assert.equal(hasSelfManagedModules({ hot_reload: { self_managed_modules: true } }), true);
    assert.equal(hasSelfManagedModules({ extension_hot_reload: { self_managed_modules: false } }), false);
});

test('finds explicit cleanup hooks before official disable hooks', () => {
    const explicit = () => {};
    const disable = () => {};
    const manifest = { hooks: { hot_reload: 'dispose', disable: 'onDisable' } };
    assert.deepEqual(findCleanupHook(manifest, { dispose: explicit, onDisable: disable }), {
        name: 'hot_reload', fn: explicit, level: 'explicit',
    });
});

test('finds only the official delete hook for deletion semantics', () => {
    const onDelete = () => {};
    const dispose = () => {};
    const manifest = { hooks: { delete: 'onDelete', hot_reload: 'dispose' } };
    assert.deepEqual(findDeletionHook(manifest, { onDelete, dispose }), {
        name: 'delete', fn: onDelete, level: 'official',
    });
    assert.equal(findDeletionHook({ hooks: { hot_reload: 'dispose' } }, { dispose }), null);
});

test('classifies safe, disabled, and forced script reloads', () => {
    assert.deepEqual(classifyScriptReload({ hasScript: true, isDisabled: false, hasCleanupHook: true, mode: HOT_RELOAD_MODE.SAFE }), {
        reloadScript: true, needsPageReload: false, reason: 'lifecycle',
    });
    assert.equal(classifyScriptReload({ hasScript: true, isDisabled: true, hasCleanupHook: false, mode: HOT_RELOAD_MODE.SAFE }).reason, 'disabled');
    assert.equal(classifyScriptReload({ hasScript: true, isDisabled: false, hasCleanupHook: false, mode: HOT_RELOAD_MODE.FORCE }).reason, 'forced');
    assert.equal(classifyScriptReload({ hasScript: true, isDisabled: false, hasCleanupHook: false, hasManagedRuntime: true, mode: HOT_RELOAD_MODE.SAFE }).reason, 'managed');
    assert.equal(classifyScriptReload({ hasScript: true, isDisabled: false, hasCleanupHook: false, mode: HOT_RELOAD_MODE.SAFE }).needsPageReload, true);
});

test('compares asset URLs without query strings', () => {
    assert.equal(isSameAsset('http://localhost/scripts/extensions/third-party/Demo/a.css?v=1', '/scripts/extensions/third-party/Demo/a.css'), true);
    assert.equal(isSameAsset('/scripts/extensions/third-party/Demo/b.css', '/scripts/extensions/third-party/Demo/a.css'), false);
});
