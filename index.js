import {
    extension_settings,
    extensionTypes,
    getExtensionManifest,
} from '../../../extensions.js';
import {
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../../script.js';
import {
    HOT_RELOAD_MODE,
    buildAssetUrl,
    classifyScriptReload,
    findCleanupHook,
    isSameAsset,
    normalizeExternalId,
    resolveExtensionType,
    toInternalId,
    withCacheBuster,
} from './lib/core.js?v=1.0.0';

const MODULE_ID = 'extension_hot_reload';
const LOG_PREFIX = '[Extension Hot Reload]';
const ROOT_ID = 'extension-hot-reload-settings';
const BULK_BUTTON_CLASS = 'extension-hot-reload-all';

const DEFAULT_SETTINGS = Object.freeze({
    interceptUpdateButtons: true,
    showBulkButton: true,
    reloadStyles: true,
    mode: HOT_RELOAD_MODE.SAFE,
    verboseLogging: false,
});

/** @type {Map<string, object>} */
const runtimeManifests = new Map();
/** @type {Set<string>} */
const updating = new Set();

let initialized = false;
let managerObserver = null;
let settings = null;
let compatibilityReadyListener = null;

function log(...args) {
    if (settings?.verboseLogging) {
        console.debug(LOG_PREFIX, ...args);
    }
}

function notify(type, message, title = '扩展热更新') {
    const toaster = globalThis.toastr;
    if (toaster && typeof toaster[type] === 'function') {
        toaster[type](message, title, { timeOut: type === 'error' ? 7000 : 5000, escapeHtml: true });
        return;
    }
    console[type === 'error' ? 'error' : 'info'](LOG_PREFIX, title, message);
}

function loadSettings() {
    const saved = extension_settings[MODULE_ID];
    settings = Object.assign({}, DEFAULT_SETTINGS, saved && typeof saved === 'object' ? saved : {});
    if (!Object.values(HOT_RELOAD_MODE).includes(settings.mode)) {
        settings.mode = HOT_RELOAD_MODE.SAFE;
    }
    extension_settings[MODULE_ID] = settings;
}

function persistSettings() {
    extension_settings[MODULE_ID] = settings;
    saveSettingsDebounced();
}

function getManifest(internalId) {
    return runtimeManifests.get(internalId) ?? getExtensionManifest(internalId);
}

function getSettingsHost() {
    return document.querySelector('#extensions_settings2')
        ?? document.querySelector('#extensions_settings')
        ?? document.querySelector('#extensions_settings_block');
}

function checkboxRow(label, key, help) {
    const row = document.createElement('label');
    row.className = 'ehr-setting-row';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(settings[key]);
    input.addEventListener('change', () => {
        settings[key] = input.checked;
        persistSettings();
        decorateManager();
    });

    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = label;
    const description = document.createElement('small');
    description.textContent = help;
    text.append(title, description);
    row.append(input, text);
    return row;
}

function renderSettings() {
    document.getElementById(ROOT_ID)?.remove();
    const host = getSettingsHost();
    if (!host) {
        log('Extension settings host was not found.');
        return;
    }

    const root = document.createElement('details');
    root.id = ROOT_ID;
    root.className = 'extension_container ehr-container';

    const summary = document.createElement('summary');
    summary.className = 'ehr-summary';
    summary.innerHTML = '<span><i class="fa-solid fa-fire-flame-curved"></i> 扩展热更新</span><small>更新后尽量直接生效</small>';

    const body = document.createElement('div');
    body.className = 'ehr-body';

    const intro = document.createElement('div');
    intro.className = 'ehr-notice';
    intro.textContent = '安全模式只热载入具备清理钩子的脚本；CSS 会直接换新。普通更新仍使用 SillyTavern 官方 Git 更新接口。';

    body.append(
        intro,
        checkboxRow('接管单个扩展的更新按钮', 'interceptUpdateButtons', '点击原下载图标时执行智能热更新。'),
        checkboxRow('显示“智能热更新全部”', 'showBulkButton', '在扩展管理器工具栏加入一个火焰按钮。'),
        checkboxRow('立即替换样式文件', 'reloadStyles', 'CSS 可安全热替换，通常无需刷新页面。'),
    );

    const modeRow = document.createElement('label');
    modeRow.className = 'ehr-mode-row';
    const modeText = document.createElement('span');
    modeText.innerHTML = '<strong>脚本策略</strong><small>强制模式可能造成重复事件监听或定时器。</small>';
    const select = document.createElement('select');
    select.className = 'text_pole';
    select.append(new Option('安全模式（推荐）', HOT_RELOAD_MODE.SAFE), new Option('实验性强制热载入', HOT_RELOAD_MODE.FORCE));
    select.value = settings.mode;
    select.addEventListener('change', () => {
        settings.mode = select.value;
        persistSettings();
    });
    modeRow.append(modeText, select);
    body.append(modeRow, checkboxRow('输出详细日志', 'verboseLogging', '在浏览器控制台记录热更新的每个阶段。'));

    const protocol = document.createElement('p');
    protocol.className = 'ehr-protocol';
    protocol.textContent = '扩展作者可在 manifest hooks 中声明 hot_reload、unload 或 disable，使脚本进入安全热更新路径。';
    body.append(protocol);

    root.append(summary, body);
    host.append(root);
}

function makeBulkButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button menu_button_icon ${BULK_BUTTON_CLASS}`;
    button.title = '智能热更新当前检测到的全部扩展';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-fire-flame-curved fa-fw';
    const label = document.createElement('span');
    label.textContent = '智能热更新全部';
    button.append(icon, label);
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void updateAllVisible(button);
    });
    return button;
}

function decorateManager() {
    document.querySelectorAll(`.${BULK_BUTTON_CLASS}`).forEach((button) => {
        button.classList.toggle('displayNone', !settings?.showBulkButton);
    });
    if (!settings?.showBulkButton) {
        return;
    }
    for (const toolbar of document.querySelectorAll('.extensions_toolbar')) {
        if (!toolbar.querySelector(`.${BULK_BUTTON_CLASS}`)) {
            toolbar.prepend(makeBulkButton());
        }
    }
}

function ensureUi() {
    if (!document.getElementById(ROOT_ID)) {
        renderSettings();
    }
    decorateManager();
}

function findUpdateButton(event) {
    if (!(event.target instanceof Element)) {
        return null;
    }
    const button = event.target.closest('.btn_update');
    return button instanceof HTMLButtonElement ? button : null;
}

function captureUpdateClick(event) {
    if (!settings?.interceptUpdateButtons) {
        return;
    }
    const button = findUpdateButton(event);
    if (!button || button.classList.contains('displayNone')) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void updateOne(button.dataset.name, button);
}

async function importExtensionModule(internalId, manifest, token = '') {
    if (!manifest?.js) {
        return null;
    }
    const baseUrl = buildAssetUrl(internalId, manifest.js);
    const url = token ? withCacheBuster(baseUrl, token) : baseUrl;
    return import(url);
}

async function invokeManifestHook(moduleNamespace, manifest, hookName, context) {
    const exportName = manifest?.hooks?.[hookName];
    const fn = typeof exportName === 'string' ? moduleNamespace?.[exportName] : undefined;
    if (typeof fn !== 'function') {
        return false;
    }
    await Promise.race([
        Promise.resolve(fn(context)),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${hookName} hook timed out.`)), 5000)),
    ]);
    return true;
}

async function fetchFreshManifest(internalId, token) {
    const url = withCacheBuster(buildAssetUrl(internalId, 'manifest.json'), token);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Could not load the updated manifest (${response.status}).`);
    }
    const manifest = await response.json();
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('The updated manifest is invalid.');
    }
    return manifest;
}

async function updateRepository(externalId, isGlobal) {
    const response = await fetch('/api/extensions/update', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ extensionName: externalId, global: isGlobal }),
    });
    if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Extension update failed (${response.status}).`);
    }
    return response.json();
}

async function replaceStyles(internalId, oldManifest, newManifest, token) {
    const oldUrl = oldManifest?.css ? buildAssetUrl(internalId, oldManifest.css) : null;
    const newUrl = newManifest?.css ? buildAssetUrl(internalId, newManifest.css) : null;
    const oldLinks = [...document.querySelectorAll('link[rel="stylesheet"][href]')]
        .filter((link) => oldUrl && isSameAsset(link.href, oldUrl));

    if (!newUrl) {
        oldLinks.forEach((link) => link.remove());
        return false;
    }

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.dataset.extensionHotReload = internalId;
    link.href = withCacheBuster(newUrl, token);
    await new Promise((resolve, reject) => {
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', () => reject(new Error('Updated stylesheet failed to load.')), { once: true });
        document.head.append(link);
    });
    oldLinks.forEach((oldLink) => oldLink.remove());
    return true;
}

function updateManagerRow(externalId, newManifest, shortHash) {
    for (const block of document.querySelectorAll('.extension_block')) {
        if (block.dataset.name !== externalId) {
            continue;
        }
        block.querySelector('.extension_name')?.classList.remove('update_available');
        const version = block.querySelector('.extension_version');
        if (version) {
            version.textContent = `${newManifest.version ?? ''}${shortHash ? ` (${shortHash})` : ''}`;
        }
        block.querySelector('.btn_update')?.classList.add('displayNone');
    }
}

async function updateOne(rawId, button = null, options = {}) {
    let externalId;
    try {
        externalId = normalizeExternalId(rawId);
    } catch (error) {
        notify('error', error.message);
        return { status: 'failed', error };
    }
    if (updating.has(externalId)) {
        return { status: 'busy' };
    }

    const internalId = toInternalId(externalId);
    const oldManifest = getManifest(internalId);
    if (!oldManifest) {
        const error = new Error(`找不到 ${externalId} 的 manifest。`);
        notify('error', error.message);
        return { status: 'failed', error };
    }

    updating.add(externalId);
    button?.setAttribute('disabled', 'disabled');
    button?.querySelector('i')?.classList.add('fa-spin');

    try {
        const isGlobal = resolveExtensionType(extensionTypes, externalId) === 'global';
        const isDisabled = extension_settings.disabledExtensions?.includes(internalId) ?? false;
        const oldModule = !isDisabled && oldManifest.js
            ? await importExtensionModule(internalId, oldManifest)
            : null;
        const cleanupHook = oldModule ? findCleanupHook(oldManifest, oldModule) : null;
        let policy = classifyScriptReload({
            hasScript: Boolean(oldManifest.js),
            isDisabled,
            hasCleanupHook: Boolean(cleanupHook),
            mode: settings.mode,
        });

        log('Updating', { externalId, isGlobal, policy, cleanupHook: cleanupHook?.name });
        const result = await updateRepository(externalId, isGlobal);
        if (result.isUpToDate) {
            if (!options.quiet) notify('success', `${oldManifest.display_name ?? externalId} 已经是最新版本。`);
            updateManagerRow(externalId, oldManifest, result.shortCommitHash);
            return { status: 'up-to-date', result };
        }

        const token = `${result.shortCommitHash ?? 'updated'}-${Date.now()}`;
        const newManifest = await fetchFreshManifest(internalId, token);
        if (!isDisabled && !oldManifest.js && newManifest.js) {
            policy = { reloadScript: true, needsPageReload: false, reason: 'new-script' };
        }
        const hookContext = Object.freeze({
            reason: 'hot-update',
            extensionName: internalId,
            previousManifest: structuredClone(oldManifest),
            manifest: structuredClone(newManifest),
        });

        let scriptReloaded = false;
        let styleReloaded = false;
        if (policy.reloadScript) {
            if (cleanupHook) {
                await Promise.race([
                    Promise.resolve(cleanupHook.fn(hookContext)),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`${cleanupHook.name} hook timed out.`)), 5000)),
                ]);
            }
            try {
                const newModule = await importExtensionModule(internalId, newManifest, token);
                await invokeManifestHook(newModule, newManifest, 'update', hookContext);
                await invokeManifestHook(newModule, newManifest, 'activate', hookContext);
                scriptReloaded = true;
            } catch (error) {
                if (cleanupHook && oldModule) {
                    try {
                        await invokeManifestHook(oldModule, oldManifest, 'activate', { ...hookContext, reason: 'hot-update-rollback' });
                    } catch (rollbackError) {
                        console.error(LOG_PREFIX, 'Rollback failed:', rollbackError);
                    }
                }
                throw error;
            }
        } else if (oldModule) {
            await invokeManifestHook(oldModule, oldManifest, 'update', hookContext);
        }

        if (!isDisabled && settings.reloadStyles && (oldManifest.css || newManifest.css)) {
            try {
                styleReloaded = await replaceStyles(internalId, oldManifest, newManifest, token);
            } catch (styleError) {
                console.error(LOG_PREFIX, 'Stylesheet hot replacement failed:', styleError);
            }
        }

        runtimeManifests.set(internalId, newManifest);
        updateManagerRow(externalId, newManifest, result.shortCommitHash);

        let status = 'files-updated';
        let message;
        if (isDisabled) {
            status = 'updated-disabled';
            message = `${newManifest.display_name ?? externalId} 已更新；它当前未启用，不需要重载运行中的脚本。`;
        } else if (scriptReloaded) {
            status = policy.reason === 'forced' ? 'force-reloaded' : 'hot-reloaded';
            message = `${newManifest.display_name ?? externalId} 已更新并热载入${styleReloaded ? '（含样式）' : ''}。`;
        } else if (!oldManifest.js) {
            status = 'style-reloaded';
            message = `${newManifest.display_name ?? externalId} 已更新${styleReloaded ? '，样式已立即生效' : ''}。`;
        } else {
            status = 'needs-page-reload';
            message = `${newManifest.display_name ?? externalId} 的文件${styleReloaded ? '和样式' : ''}已更新，但脚本没有清理钩子；为避免重复监听，本次未强制重载脚本。`;
        }
        if (!options.quiet) {
            notify(status === 'needs-page-reload' ? 'warning' : 'success', message);
        }
        return { status, result, message };
    } catch (error) {
        console.error(LOG_PREFIX, `Failed to update ${externalId}:`, error);
        if (!options.quiet) notify('error', `${externalId} 更新失败：${error.message}`);
        return { status: 'failed', error };
    } finally {
        updating.delete(externalId);
        button?.removeAttribute('disabled');
        button?.querySelector('i')?.classList.remove('fa-spin');
    }
}

async function updateAllVisible(button) {
    if (button.disabled) return;
    const targets = [...document.querySelectorAll('.extension_block .btn_update:not(.displayNone)')]
        .map((item) => item.dataset.name)
        .filter(Boolean);
    if (!targets.length) {
        notify('info', '当前列表里没有检测到可用更新。请等扩展检查完成后再试一次。');
        return;
    }

    button.disabled = true;
    button.querySelector('i')?.classList.add('fa-spin');
    const results = [];
    for (const id of targets) {
        results.push(await updateOne(id, null, { quiet: true }));
    }
    button.disabled = false;
    button.querySelector('i')?.classList.remove('fa-spin');

    const failed = results.filter((item) => item.status === 'failed').length;
    const needsReload = results.filter((item) => item.status === 'needs-page-reload').length;
    const hot = results.filter((item) => ['hot-reloaded', 'force-reloaded', 'style-reloaded', 'updated-disabled'].includes(item.status)).length;
    const summary = `完成 ${results.length} 个：${hot} 个已直接应用，${needsReload} 个脚本需稍后刷新，${failed} 个失败。`;
    notify(failed ? 'warning' : needsReload ? 'warning' : 'success', summary, '批量热更新完成');
}

function startObserver() {
    managerObserver?.disconnect();
    managerObserver = new MutationObserver(() => ensureUi());
    managerObserver.observe(document.body, { childList: true, subtree: true });
    ensureUi();
}

function teardown() {
    document.removeEventListener('click', captureUpdateClick, true);
    if (compatibilityReadyListener) {
        document.removeEventListener('DOMContentLoaded', compatibilityReadyListener);
        compatibilityReadyListener = null;
    }
    managerObserver?.disconnect();
    managerObserver = null;
    document.getElementById(ROOT_ID)?.remove();
    document.querySelectorAll(`.${BULK_BUTTON_CLASS}`).forEach((button) => button.remove());
    initialized = false;
}

function initialize() {
    if (initialized) return;
    initialized = true;
    loadSettings();
    renderSettings();
    document.addEventListener('click', captureUpdateClick, true);
    startObserver();
    console.info(LOG_PREFIX, 'Loaded.');
}

export function onActivate() {
    initialize();
}

export function onUpdate() {
    loadSettings();
    renderSettings();
}

export function onDisable() {
    teardown();
}

export function onHotUnload() {
    teardown();
}

// Compatibility with SillyTavern versions that load extension modules but do
// not invoke manifest activation hooks yet. The initializer is idempotent.
if (document.readyState === 'loading') {
    compatibilityReadyListener = initialize;
    document.addEventListener('DOMContentLoaded', compatibilityReadyListener, { once: true });
} else {
    queueMicrotask(initialize);
}
