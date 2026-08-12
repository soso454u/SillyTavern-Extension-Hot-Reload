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
