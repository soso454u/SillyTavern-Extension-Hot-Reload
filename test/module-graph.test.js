import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareModuleGraph } from '../lib/module-graph.js';

const rootUrl = 'https://tavern.local/scripts/extensions/third-party/Demo/';

function fixture(files, token = 'v1') {
    const fetched = [];
    const sources = [];
    const revoked = [];
    return {
        fetched, sources, revoked,
        options: {
            entryUrl: `${rootUrl}index.js`, rootUrl, token,
            fetchSource: async (url) => {
                fetched.push(url);
                const file = new URL(url).pathname.slice(new URL(rootUrl).pathname.length);
                if (!(file in files)) throw new Error(`missing: ${file}`);
                return files[file];
            },
            createUrl: (source) => {
                sources.push(source);
                return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
            },
            revokeUrl: (url) => revoked.push(url),
        },
    };
}

test('executes fresh nested modules, re-exports and lazy imports across successive updates', async () => {
    for (const version of [1, 2]) {
        const f = fixture({
            'index.js': `import { value } from './lib/helper.js';
                export { other } from './other.js';
                export const current = value;
                export const lazy = () => import('./lazy.js');
                export const originalUrl = import.meta.url;`,
            'lib/helper.js': `export const value = ${version};`,
            'other.js': `export { value as other } from './lib/helper.js';`,
            'lazy.js': `export const value = ${version};`,
        }, `v${version}`);
        const graph = await prepareModuleGraph(f.options);
        const module = await import(graph.entryUrl);
        assert.equal(module.current, version);
        assert.equal(module.other, version);
        assert.equal((await module.lazy()).value, version);
        assert.equal(module.originalUrl, `${rootUrl}index.js?st_hot_reload=v${version}`);
        assert.equal(graph.moduleCount, 4);
        assert.equal(f.fetched.length, 4);
        assert.ok(f.fetched.every((url) => new URL(url).searchParams.get('st_hot_reload') === `v${version}`));
        assert.equal(f.revoked.length, 0);
        graph.dispose();
        graph.dispose();
        assert.equal(f.revoked.length, 4);
    }
});

test('keeps host singleton imports canonical and ignores comments, regexes and import-like text', async () => {
    const f = fixture({ 'index.js': `
        import { eventSource } from '../../../extensions.js';
        // import './missing.js';
        const text = "import './also-missing.js'";
        const regex = /import\\(['"]/;
        export { eventSource };` });
    const graph = await prepareModuleGraph(f.options);
    assert.equal(f.fetched.length, 1);
    assert.match(f.sources[0], /https:\/\/tavern.local\/scripts\/extensions.js/);
    assert.doesNotMatch(f.sources[0], /extensions.js\?st_hot_reload/);
    graph.dispose();
});

test('handles commented and escaped specifiers without corrupting quote boundaries', async () => {
    const f = fixture({
        'index.js': `export const lazy = () => import /* comment */ ('./it\\'s.js');`,
        "it's.js": 'export const value = 42;',
    });
    const graph = await prepareModuleGraph(f.options);
    assert.equal((await (await import(graph.entryUrl)).lazy()).value, 42);
    graph.dispose();
});

test('rejects cycles, computed imports, unsupported meta and workers before execution', async () => {
    for (const files of [
        { 'index.js': `import './child.js';`, 'child.js': `import './index.js';` },
        { 'index.js': `const path = './child.js'; import(path);` },
        { 'index.js': `import.meta.resolve('./child.js');` },
        { 'index.js': `new Worker(new URL('./worker.js', import.meta.url));` },
        { 'index.js': `import 'alias';` },
        { 'index.js': `import data from './data.json' with { type: 'json' };` },
    ]) {
        const f = fixture(files);
        await assert.rejects(prepareModuleGraph(f.options));
        assert.equal(f.revoked.length, f.sources.length);
    }
});

test('releases prepared URLs when another dependency cannot be fetched', async () => {
    const f = fixture({ 'index.js': `import './ok.js'; import './missing.js';`, 'ok.js': 'export {};' });
    await assert.rejects(prepareModuleGraph(f.options), /missing/);
    assert.equal(f.revoked.length, 1);
});

test('bounds graph size and rejects entry points outside the extension directory', async () => {
    const f = fixture({ 'index.js': `import './child.js';`, 'child.js': 'export {};' });
    await assert.rejects(prepareModuleGraph({ ...f.options, maxModules: 1 }), /上限/);
    await assert.rejects(prepareModuleGraph({ ...f.options, entryUrl: 'https://other.local/x.js' }), /目录内/);
});
