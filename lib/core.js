export const HOT_RELOAD_MODE = Object.freeze({
    SAFE: 'safe',
    FORCE: 'force',
});

/**
 * Produce a stable drawer title for restart-state matching.
 * SillyTavern may append a transient "New!" badge to extension headings.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDrawerTitle(value) {
    return String(value ?? '').replace(/\s*\bnew\s*!?\s*$/i, '').replace(/\s+/g, ' ').trim();
}

/**
 * Convert a SillyTavern extension id to the external form used by the API.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeExternalId(value) {
    let id = String(value ?? '').trim();
    if (id.startsWith('third-party/')) {
        id = id.slice('third-party'.length);
    }
    if (id && !id.startsWith('/')) {
        id = `/${id}`;
    }
    if (!id || id === '/' || id.includes('\\') || id.split('/').includes('..')) {
        throw new Error('Invalid extension id.');
    }
    return id;
}

/**
 * Convert an API extension id to SillyTavern's internal manifest key.
 * @param {unknown} value
 * @returns {string}
 */
export function toInternalId(value) {
    return `third-party${normalizeExternalId(value)}`;
}

/**
 * Resolve the local/global type from SillyTavern's live extension type map.
 * @param {Record<string, string>} extensionTypes
 * @param {string} externalId
 * @returns {string}
 */
export function resolveExtensionType(extensionTypes, externalId) {
    const external = normalizeExternalId(externalId);
    const internal = toInternalId(external);
    const key = Object.keys(extensionTypes ?? {}).find((item) => item === internal || item.endsWith(external));
    return key ? extensionTypes[key] : '';
}

/**
 * Build a same-origin URL for a file declared by an extension manifest.
 * @param {string} internalId
 * @param {string} file
 * @returns {string}
 */
export function buildAssetUrl(internalId, file) {
    const idParts = String(internalId).split('/');
    const fileParts = String(file ?? '').split('/');
    const parts = [...idParts, ...fileParts];
    if (!file || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
        throw new Error('Invalid extension asset path.');
    }
    return `/scripts/extensions/${parts.map(encodeURIComponent).join('/')}`;
}

/**
 * Add a cache-busting query without losing existing query parameters.
 * @param {string} url
 * @param {string} token
 * @returns {string}
 */
export function withCacheBuster(url, token) {
    const result = new URL(url, 'http://sillytavern.local');
    result.searchParams.set('st_hot_reload', token);
    return `${result.pathname}${result.search}${result.hash}`;
}

/**
 * Find an explicit lifecycle hook that can stop the old runtime.
 * `hot_reload` and `unload` are opt-in protocol hooks. `disable` is the
 * closest official SillyTavern lifecycle hook and is used as a safe fallback.
 * @param {object} manifest
 * @param {Record<string, unknown>} moduleNamespace
 * @returns {{name: string, fn: Function, level: string}|null}
 */
export function findCleanupHook(manifest, moduleNamespace) {
    const hooks = manifest?.hooks;
    if (!hooks || typeof hooks !== 'object') {
        return null;
    }

    for (const [hookName, level] of [['hot_reload', 'explicit'], ['unload', 'explicit'], ['disable', 'official']]) {
        const exportName = hooks[hookName];
        const fn = typeof exportName === 'string' ? moduleNamespace?.[exportName] : undefined;
        if (typeof fn === 'function') {
            return { name: hookName, fn, level };
        }
    }
    return null;
}

/**
 * Find the official hook called before an extension is deleted from disk.
 * This hook is not treated as proof that the live runtime can be unloaded.
 * @param {object} manifest
 * @param {Record<string, unknown>} moduleNamespace
 * @returns {{name: string, fn: Function, level: string}|null}
 */
export function findDeletionHook(manifest, moduleNamespace) {
    const hooks = manifest?.hooks;
    if (!hooks || typeof hooks !== 'object') {
        return null;
    }

    const exportName = hooks.delete;
    const fn = typeof exportName === 'string' ? moduleNamespace?.[exportName] : undefined;
    return typeof fn === 'function' ? { name: 'delete', fn, level: 'official' } : null;
}

/**
 * Decide whether an active script can be reloaded under the selected policy.
 * @param {{hasScript: boolean, isDisabled: boolean, hasCleanupHook: boolean, mode: string}} input
 * @returns {{reloadScript: boolean, needsPageReload: boolean, reason: string}}
 */
export function classifyScriptReload(input) {
    if (!input.hasScript) {
        return { reloadScript: false, needsPageReload: false, reason: 'no-script' };
    }
    if (input.isDisabled) {
        return { reloadScript: false, needsPageReload: false, reason: 'disabled' };
    }
    if (input.hasCleanupHook) {
        return { reloadScript: true, needsPageReload: false, reason: 'lifecycle' };
    }
    if (input.mode === HOT_RELOAD_MODE.FORCE) {
        return { reloadScript: true, needsPageReload: false, reason: 'forced' };
    }
    return { reloadScript: false, needsPageReload: true, reason: 'missing-cleanup' };
}

/**
 * Does a stylesheet/script URL point at a given manifest asset?
 * @param {string} candidate
 * @param {string} assetUrl
 * @returns {boolean}
 */
export function isSameAsset(candidate, assetUrl) {
    try {
        const left = decodeURIComponent(new URL(candidate, 'http://sillytavern.local').pathname);
        const right = decodeURIComponent(new URL(assetUrl, 'http://sillytavern.local').pathname);
        return left === right;
    } catch {
        return false;
    }
}
