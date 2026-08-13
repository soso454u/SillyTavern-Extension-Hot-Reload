export const HOT_RELOAD_MODE = Object.freeze({
    SAFE: 'safe',
    FORCE: 'force',
});

const UPDATE_ALL_LABELS = new Set([
    'update all',
    '更新全部',
    '全部更新',
    'すべて更新',
    '모두 업데이트',
]);

const MANIFEST_STRUCTURE_FIELDS = Object.freeze([
    'js',
    'hooks',
    'dependencies',
    'requires',
    'optional',
    'loading_order',
    'minimum_client_version',
]);

const MANAGED_RUNTIME_RISK_PATTERNS = Object.freeze([
    ['global-assignment', /\b(?:window|globalThis)\s*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*=(?!=)/],
    ['prototype-mutation', /(?:\.prototype\s*(?:\.|\[)|Object\.(?:defineProperty|defineProperties|assign)\s*\([^\n;]*\.prototype\b)/],
    ['html-replacement', /(?:\.innerHTML\s*=|\.outerHTML\s*=|\binsertAdjacentHTML\s*\(|\bdocument\.write\s*\()/],
    ['existing-dom-mutation', /(?:\.classList\.(?:add|remove|replace|toggle)\s*\(|\.style(?:\.[\w$-]+|\[[^\]]+\])\s*=|\.(?:setAttribute|removeAttribute|toggleAttribute|replaceChildren|replaceWith|removeChild)\s*\(|\.(?:textContent|nodeValue)\s*=|\.(?:addClass|removeClass|toggleClass|css|attr|prop)\s*\()/],
    ['dynamic-code', /(?:\beval\s*\(|\bnew\s+Function\s*\()/],
    ['opaque-dynamic-import', /\bimport\s*\(\s*(?!["'])/],
    ['custom-element', /\bcustomElements\.define\s*\(/],
    ['external-registry', /\b(?:registerSlashCommand|registerMacro|registerFunction|registerCommand|SlashCommandParser)\b/],
    ['special-runtime', /\b(?:AudioContext|OfflineAudioContext|RTCPeerConnection|WebAssembly|registerProcessor|getUserMedia)\b/],
]);

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
 * Recognize the extension manager's update-all control across native i18n
 * metadata, translated labels, and older popup implementations.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUpdateAllLabel(value) {
    const normalized = String(value ?? '')
        .trim()
        .replace(/^\[[^\]]+\]\s*/, '')
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase();
    return UPDATE_ALL_LABELS.has(normalized);
}

/**
 * Normalize the extension-update response used by SillyTavern and native
 * hosts. Unknown response shapes must not be mistaken for a completed update,
 * because that could trigger a page reload after an API failure.
 * @param {unknown} value
 * @returns {Record<string, unknown> & {isUpToDate: boolean, shortCommitHash: string}}
 */
export function normalizeRepositoryUpdateResult(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('The extension update returned an invalid result.');
    }

    const result = /** @type {Record<string, unknown>} */ (value);
    const isUpToDate = result.isUpToDate ?? result.is_up_to_date;
    if (typeof isUpToDate !== 'boolean') {
        throw new Error('The extension update result did not confirm whether files changed.');
    }

    const rawHash = result.shortCommitHash ?? result.short_commit_hash;
    const shortCommitHash = typeof rawHash === 'string' ? rawHash : '';
    return { ...result, isUpToDate, shortCommitHash };
}

/**
 * Only a verified on-disk update may request an automatic page reload.
 * @param {unknown} value
 * @returns {boolean}
 */
export function shouldAutoRestartUpdate(value) {
    return Boolean(value
        && typeof value === 'object'
        && value.status === 'needs-page-reload'
        && value.updateVerified === true);
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
 * Find module specifiers that resolve to another file inside the same extension.
 * This intentionally prefers false positives over mixed-version module graphs.
 * @param {string} source
 * @param {string|URL} entryUrl
 * @param {string|URL} extensionRootUrl
 * @returns {string[]}
 */
export function findLocalModuleDependencies(source, entryUrl, extensionRootUrl) {
    const entry = new URL(entryUrl, 'http://sillytavern.local');
    const root = new URL(extensionRootUrl, entry.origin);
    const rootPath = root.pathname.endsWith('/') ? root.pathname : `${root.pathname}/`;
    const patterns = [
        /\b(?:import\s+(?:[^"'()]*?\s+from\s*)?|export\s+(?:[^"']*?\s+from\s*)?|import\s*\()\s*["']([^"']+)["']/g,
        /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
        /\bnew\s+(?:Worker|SharedWorker)\s*\(\s*["']([^"']+)["']/g,
    ];
    const dependencies = [];

    for (const pattern of patterns) {
        for (const match of String(source ?? '').matchAll(pattern)) {
            const specifier = match[1];
            if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
            const resolved = new URL(specifier, entry);
            if (resolved.origin === entry.origin
                && resolved.pathname.startsWith(rootPath)
                && resolved.pathname !== entry.pathname) {
                dependencies.push(specifier);
            }
        }
    }
    return [...new Set(dependencies)];
}

function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

/**
 * Find manifest fields whose changes require SillyTavern to rebuild its own
 * extension lifecycle state. Cosmetic metadata such as version and display
 * name is deliberately excluded.
 * @param {object} previousManifest
 * @param {object} nextManifest
 * @returns {string[]}
 */
export function findManifestStructureChanges(previousManifest, nextManifest) {
    return MANIFEST_STRUCTURE_FIELDS.filter((field) => JSON.stringify(canonicalize(previousManifest?.[field]))
        !== JSON.stringify(canonicalize(nextManifest?.[field])));
}

/**
 * Find source patterns whose effects cannot be reversed reliably by the
 * managed runtime supervisor. This is deliberately conservative and augments
 * runtime tracking; it is not presented as a complete JavaScript parser.
 * @param {string} source
 * @returns {string[]}
 */
export function findManagedRuntimeRisks(source) {
    const text = String(source ?? '');
    return MANAGED_RUNTIME_RISK_PATTERNS
        .filter(([, pattern]) => pattern.test(text))
        .map(([name]) => name);
}

/**
 * Whether an extension explicitly promises to refresh its own local module
 * and runtime-resource URLs during hot activation.
 * @param {object} manifest
 * @returns {boolean}
 */
export function hasSelfManagedModules(manifest) {
    return manifest?.extension_hot_reload?.self_managed_modules === true
        || manifest?.hot_reload?.self_managed_modules === true;
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
 * @param {{hasScript: boolean, isDisabled: boolean, hasCleanupHook: boolean, hasManagedRuntime?: boolean, mode: string}} input
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
    if (input.hasManagedRuntime) {
        return { reloadScript: true, needsPageReload: false, reason: 'managed' };
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
