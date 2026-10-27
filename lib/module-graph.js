import { parse } from '../vendor/es-module-lexer.js';

/**
 * Prepare an isolated, fresh module graph before unloading a running extension.
 * Shared host modules keep their canonical URLs. Blob URLs remain alive for
 * lazy imports until this runtime is replaced. Cycles and computed imports are
 * rejected rather than silently mixing old and new modules.
 */
export async function prepareModuleGraph({ entryUrl, rootUrl, token, fetchSource,
    createUrl = (source) => URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
    revokeUrl = (url) => URL.revokeObjectURL(url), onModule = () => {}, maxModules = 256 }) {
    const root = new URL(rootUrl);
    const rootPath = root.pathname.endsWith('/') ? root.pathname : `${root.pathname}/`;
    const modules = new Map();
    const visiting = new Set();
    const urls = [];
    const dispose = () => {
        for (const url of urls.splice(0)) revokeUrl(url);
    };
    const isLocal = (url) => url.origin === root.origin && url.pathname.startsWith(rootPath);
    const versioned = (url) => {
        const fresh = new URL(url);
        fresh.searchParams.set('st_hot_reload', token);
        return fresh.href;
    };

    async function visit(input) {
        const url = new URL(input);
        url.searchParams.delete('st_hot_reload');
        const key = url.href;
        if (visiting.has(key)) throw new Error(`暂不支持循环模块依赖：${url.pathname}`);
        if (modules.has(key)) return modules.get(key);
        if (modules.size + visiting.size >= maxModules) throw new Error('模块数量超过强制热更新上限。');
        visiting.add(key);
        const source = await fetchSource(versioned(url));
        if (/\b(?:Worker|SharedWorker)\s*\(/.test(source)) {
            throw new Error(`暂不支持自动换新 Worker 运行资源：${url.pathname}`);
        }
        const [imports] = parse(source, url.pathname);
        const edits = [];
        for (const record of imports) {
            if (record.d === -2) {
                const suffix = source.slice(record.e).match(/^\s*\.\s*url\b/);
                if (!suffix) throw new Error(`暂不支持此 import.meta 用法：${url.pathname}`);
                edits.push({ start: record.s, end: record.e + suffix[0].length, text: JSON.stringify(versioned(url)) });
                continue;
            }
            if (record.n === undefined) throw new Error(`暂不支持计算路径的动态 import：${url.pathname}`);
            const specifier = record.n;
            if (!/^(?:\.{1,2}\/|\/|[a-zA-Z][\w+.-]*:)/.test(specifier)) {
                throw new Error(`暂不支持裸模块别名：${specifier}`);
            }
            const resolved = new URL(specifier, url);
            let target = resolved.href;
            if (isLocal(resolved)) {
                if (record.a >= 0 || ![1, 2].includes(record.t)) {
                    throw new Error(`暂不支持带属性或特殊阶段的本地模块：${specifier}`);
                }
                target = await visit(resolved);
            }
            // Static records exclude quotes; dynamic records include them.
            edits.push({ start: record.d >= 0 ? record.s : record.s - 1,
                end: record.d >= 0 ? record.e : record.e + 1, text: JSON.stringify(target) });
        }
        let rewritten = source;
        for (const edit of edits.sort((left, right) => right.start - left.start)) {
            rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
        }
        const blobUrl = createUrl(`${rewritten}\n//# sourceURL=${versioned(url).replace(/[\r\n]/g, '')}\n`);
        urls.push(blobUrl);
        onModule(blobUrl, key);
        modules.set(key, blobUrl);
        visiting.delete(key);
        return blobUrl;
    }

    try {
        if (!isLocal(new URL(entryUrl))) throw new Error('模块入口必须位于目标扩展目录内。');
        return { entryUrl: await visit(entryUrl), dispose, moduleCount: modules.size };
    } catch (error) {
        dispose();
        throw error;
    }
}
