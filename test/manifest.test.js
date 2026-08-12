import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifestUrl = new URL('../manifest.json', import.meta.url);
const entryUrl = new URL('../index.js', import.meta.url);

test('declares a first-install lifecycle entry that is exported by the module', async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
    const entrySource = await readFile(entryUrl, 'utf8');

    assert.equal(manifest.hooks.install, 'onInstall');
    assert.match(entrySource, /export function onInstall\s*\(/);
});

test('keeps the entry compatible with extension modules that lack getExtensionManifest', async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
    const entrySource = await readFile(entryUrl, 'utf8');

    assert.match(entrySource, /import \* as extensionsApi from ['"]\.\.\/\.\.\/\.\.\/extensions\.js['"]/);
    assert.doesNotMatch(entrySource, /import\s*\{[^}]*getExtensionManifest[^}]*\}\s*from/s);
    assert.match(entrySource, new RegExp(`const PLUGIN_VERSION = ['"]${manifest.version}['"]`));
    assert.match(entrySource, /version\.textContent = `v\$\{PLUGIN_VERSION\}`/);
});
