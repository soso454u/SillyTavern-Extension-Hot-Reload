import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HOT_RELOAD_MODE,
    buildAssetUrl,
    classifyScriptReload,
    findCleanupHook,
    isSameAsset,
    normalizeDrawerTitle,
    normalizeExternalId,
    resolveExtensionType,
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

test('finds explicit cleanup hooks before official disable hooks', () => {
    const explicit = () => {};
    const disable = () => {};
    const manifest = { hooks: { hot_reload: 'dispose', disable: 'onDisable' } };
    assert.deepEqual(findCleanupHook(manifest, { dispose: explicit, onDisable: disable }), {
        name: 'hot_reload', fn: explicit, level: 'explicit',
    });
});

test('classifies safe, disabled, and forced script reloads', () => {
    assert.deepEqual(classifyScriptReload({ hasScript: true, isDisabled: false, hasCleanupHook: true, mode: HOT_RELOAD_MODE.SAFE }), {
        reloadScript: true, needsPageReload: false, reason: 'lifecycle',
    });
    assert.equal(classifyScriptReload({ hasScript: true, isDisabled: true, hasCleanupHook: false, mode: HOT_RELOAD_MODE.SAFE }).reason, 'disabled');
    assert.equal(classifyScriptReload({ hasScript: true, isDisabled: false, hasCleanupHook: false, mode: HOT_RELOAD_MODE.FORCE }).reason, 'forced');
    assert.equal(classifyScriptReload({ hasScript: true, isDisabled: false, hasCleanupHook: false, mode: HOT_RELOAD_MODE.SAFE }).needsPageReload, true);
});

test('compares asset URLs without query strings', () => {
    assert.equal(isSameAsset('http://localhost/scripts/extensions/third-party/Demo/a.css?v=1', '/scripts/extensions/third-party/Demo/a.css'), true);
    assert.equal(isSameAsset('/scripts/extensions/third-party/Demo/b.css', '/scripts/extensions/third-party/Demo/a.css'), false);
});
