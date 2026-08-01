import {
    extension_settings,
    extensionTypes,
    getExtensionManifest,
} from '../../../extensions.js';
import {
    eventSource,
    event_types,
    getRequestHeaders,
    isGenerating,
    saveSettingsDebounced,
} from '../../../../script.js';
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
} from './lib/core.js?v=1.2.0';

const MODULE_ID = 'extension_hot_reload';
const LOG_PREFIX = '[Extension Hot Reload]';
const ROOT_ID = 'extension-hot-reload-settings';
const BULK_BUTTON_CLASS = 'extension-hot-reload-all';
const RESTART_OVERLAY_ID = 'extension-hot-reload-restart-overlay';
const RESTART_STATE_KEY = 'extension-hot-reload:restart-state';
const RESTART_STATE_MAX_AGE = 2 * 60 * 1000;
const RESTART_STATE_VERSION = 2;
const LATE_RESTORE_TIMEOUT = 6000;

const DEFAULT_SETTINGS = Object.freeze({
    interceptUpdateButtons: true,
    showBulkButton: true,
    reloadStyles: true,
    seamlessFallback: true,
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
let restoreReadyHandler = null;
let restoreFallbackTimer = null;
let lateRestoreObserver = null;
let lateRestoreTimer = null;
let restoreInteractionHandler = null;
let generationResumeHandler = null;
let restartPending = false;

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
    row.className = 'checkbox_label ehr-setting-row';

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

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'inline-drawer ehr-container';

    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle inline-drawer-header';
    const heading = document.createElement('b');
    heading.className = 'ehr-drawer-title';
    const headingIcon = document.createElement('i');
    headingIcon.className = 'fa-solid fa-fire-flame-curved';
    const headingText = document.createElement('span');
    headingText.textContent = '扩展热更新';
    heading.append(headingIcon, headingText);
    const drawerIcon = document.createElement('div');
    drawerIcon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
    header.append(heading, drawerIcon);

    const body = document.createElement('div');
    body.className = 'inline-drawer-content ehr-body';

    const intro = document.createElement('div');
    intro.className = 'ehr-notice';
    intro.textContent = '安全模式只热载入具备清理钩子的脚本；CSS 会直接换新。普通更新仍使用 SillyTavern 官方 Git 更新接口。';

    body.append(
        intro,
        checkboxRow('接管单个扩展的更新按钮', 'interceptUpdateButtons', '点击原下载图标时执行智能热更新。'),
        checkboxRow('显示“智能热更新全部”', 'showBulkButton', '在扩展管理器工具栏加入一个火焰按钮。'),
        checkboxRow('立即替换样式文件', 'reloadStyles', 'CSS 可安全热替换，通常无需刷新页面。'),
        checkboxRow('不兼容脚本自动无感重启', 'seamlessFallback', '保存输入和聊天位置，自动刷新运行环境并恢复；目标扩展无需适配。'),
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

    root.append(header, body);
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
    void updateOne(button.dataset.name, button).then((result) => {
        if (result.status === 'needs-page-reload' && settings.seamlessFallback) {
            return requestSeamlessRestart([result.displayName ?? button.dataset.name]);
        }
    });
}

function findVisibleChatAnchor(chat) {
    const chatRect = chat.getBoundingClientRect();
    const messages = [...chat.querySelectorAll('.mes[mesid]')];
    const anchor = messages.find((message) => {
        const rect = message.getBoundingClientRect();
        return rect.bottom > chatRect.top && rect.top < chatRect.bottom;
    });
    if (!anchor) return null;
    const rect = anchor.getBoundingClientRect();
    return {
        messageId: anchor.getAttribute('mesid'),
        offset: rect.top - chatRect.top,
    };
}

function getDrawerTitle(drawer) {
    const header = drawer.querySelector(':scope > .inline-drawer-header');
    const title = header?.querySelector('b')?.textContent ?? header?.textContent ?? '';
    return normalizeDrawerTitle(title);
}

function captureOpenDrawerReferences() {
    const occurrences = new Map();
    const references = [];
    for (const drawer of document.querySelectorAll('.inline-drawer')) {
        const title = getDrawerTitle(drawer);
        const occurrence = occurrences.get(title) ?? 0;
        occurrences.set(title, occurrence + 1);
        const content = drawer.querySelector(':scope > .inline-drawer-content');
        if (!(content instanceof HTMLElement) || getComputedStyle(content).display === 'none') continue;
        if (!drawer.id && !title) continue;
        references.push({ id: drawer.id || '', title, occurrence });
    }
    return references;
}

function captureScrollPositions() {
    return [...document.querySelectorAll('[id]')]
        .filter((element) => element instanceof HTMLElement
            && element.id !== 'chat'
            && (element.scrollTop !== 0 || element.scrollLeft !== 0)
            && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth))
        .slice(0, 50)
        .map((element) => ({ id: element.id, top: element.scrollTop, left: element.scrollLeft }));
}

function captureRestartState(updatedExtensions) {
    const textarea = document.querySelector('#send_textarea');
    const chat = document.querySelector('#chat');
    const distanceFromBottom = chat ? chat.scrollHeight - chat.clientHeight - chat.scrollTop : 0;
    const activeElement = document.activeElement;
    return {
        version: RESTART_STATE_VERSION,
        createdAt: Date.now(),
        path: `${location.pathname}${location.search}${location.hash}`,
        updatedExtensions: updatedExtensions.filter(Boolean).map(String),
        draft: textarea instanceof HTMLTextAreaElement ? textarea.value : '',
        selectionStart: textarea instanceof HTMLTextAreaElement ? textarea.selectionStart : null,
        selectionEnd: textarea instanceof HTMLTextAreaElement ? textarea.selectionEnd : null,
        chatScrollTop: chat instanceof HTMLElement ? chat.scrollTop : null,
        chatAtBottom: Math.abs(distanceFromBottom) < 8,
        chatAnchor: chat instanceof HTMLElement ? findVisibleChatAnchor(chat) : null,
        documentScrollX: window.scrollX,
        documentScrollY: window.scrollY,
        openDetails: [...document.querySelectorAll('details[open][id]')].map((item) => item.id),
        openInlineDrawers: captureOpenDrawerReferences(),
        scrollPositions: captureScrollPositions(),
        focusedElementId: activeElement instanceof HTMLElement ? activeElement.id : '',
    };
}

function readRestartState() {
    try {
        const raw = sessionStorage.getItem(RESTART_STATE_KEY);
        if (!raw) return null;
        const state = JSON.parse(raw);
        const currentPath = `${location.pathname}${location.search}${location.hash}`;
        if (!state || state.version !== RESTART_STATE_VERSION || state.path !== currentPath || Date.now() - state.createdAt > RESTART_STATE_MAX_AGE) {
            sessionStorage.removeItem(RESTART_STATE_KEY);
            return null;
        }
        return state;
    } catch (error) {
        console.warn(LOG_PREFIX, 'Could not read seamless restart state:', error);
        return null;
    }
}

function resolveDrawer(reference) {
    if (reference.id) {
        const byId = document.getElementById(reference.id);
        if (byId?.classList.contains('inline-drawer')) return byId;
    }
    if (!reference.title) return null;
    const matches = [...document.querySelectorAll('.inline-drawer')]
        .filter((drawer) => getDrawerTitle(drawer) === reference.title);
    return matches[reference.occurrence ?? 0] ?? null;
}

function openInlineDrawer(drawer) {
    const content = drawer.querySelector(':scope > .inline-drawer-content');
    const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
    if (!(content instanceof HTMLElement)) return false;
    content.style.display = 'block';
    if (icon instanceof HTMLElement) {
        icon.classList.remove('down', 'fa-circle-chevron-down');
        icon.classList.add('up', 'fa-circle-chevron-up');
    }
    return true;
}

function restorePrimaryState(state) {
    const textarea = document.querySelector('#send_textarea');
    if (textarea instanceof HTMLTextAreaElement) {
        textarea.value = typeof state.draft === 'string' ? state.draft : '';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        if (Number.isInteger(state.selectionStart) && Number.isInteger(state.selectionEnd)) {
            textarea.setSelectionRange(state.selectionStart, state.selectionEnd);
        }
    }

    const chat = document.querySelector('#chat');
    if (chat instanceof HTMLElement) {
        if (state.chatAtBottom) {
            chat.scrollTop = chat.scrollHeight;
        } else if (state.chatAnchor?.messageId != null) {
            const selector = `.mes[mesid="${CSS.escape(String(state.chatAnchor.messageId))}"]`;
            const anchor = chat.querySelector(selector);
            if (anchor instanceof HTMLElement) {
                const currentOffset = anchor.getBoundingClientRect().top - chat.getBoundingClientRect().top;
                chat.scrollTop += currentOffset - Number(state.chatAnchor.offset ?? 0);
            } else if (Number.isFinite(state.chatScrollTop)) {
                chat.scrollTop = state.chatScrollTop;
            }
        } else if (Number.isFinite(state.chatScrollTop)) {
            chat.scrollTop = state.chatScrollTop;
        }
    }

    window.scrollTo(Number(state.documentScrollX ?? 0), Number(state.documentScrollY ?? 0));
    if (state.focusedElementId === 'send_textarea' && textarea instanceof HTMLTextAreaElement && !matchMedia('(pointer: coarse)').matches) {
        textarea.focus({ preventScroll: true });
    }
}

function clearLateRestoreWatchers() {
    lateRestoreObserver?.disconnect();
    lateRestoreObserver = null;
    if (lateRestoreTimer) {
        clearTimeout(lateRestoreTimer);
        lateRestoreTimer = null;
    }
    if (restoreInteractionHandler) {
        for (const eventName of ['pointerdown', 'wheel', 'touchstart', 'keydown']) {
            document.removeEventListener(eventName, restoreInteractionHandler, true);
        }
        restoreInteractionHandler = null;
    }
}

function restoreLateMountedUi(state) {
    const pendingDetails = new Set(state.openDetails ?? []);
    const pendingDrawers = [...(state.openInlineDrawers ?? [])];
    const pendingScrolls = [...(state.scrollPositions ?? [])];
    let completed = false;

    const finish = () => {
        if (completed) return;
        completed = true;
        const fullyRestored = pendingDetails.size === 0 && pendingDrawers.length === 0 && pendingScrolls.length === 0;
        clearLateRestoreWatchers();
        sessionStorage.removeItem(RESTART_STATE_KEY);
        const names = Array.isArray(state.updatedExtensions) ? state.updatedExtensions.join('、') : '';
        const message = fullyRestored
            ? `${names || '扩展'} 已更新，输入内容和界面位置已恢复。`
            : `${names || '扩展'} 已更新，输入内容已恢复；为避免打断操作，已停止继续调整迟到的界面位置。`;
        notify('success', message, '无感重启完成');
    };

    const tryRestore = () => {
        for (const id of [...pendingDetails]) {
            const details = document.getElementById(id);
            if (details instanceof HTMLDetailsElement) {
                details.open = true;
                pendingDetails.delete(id);
            }
        }
        for (let index = pendingDrawers.length - 1; index >= 0; index--) {
            const drawer = resolveDrawer(pendingDrawers[index]);
            if (drawer && openInlineDrawer(drawer)) pendingDrawers.splice(index, 1);
        }
        for (let index = pendingScrolls.length - 1; index >= 0; index--) {
            const position = pendingScrolls[index];
            const element = document.getElementById(position.id);
            if (!(element instanceof HTMLElement)) continue;
            const canRestoreTop = element.scrollHeight - element.clientHeight + 2 >= position.top;
            const canRestoreLeft = element.scrollWidth - element.clientWidth + 2 >= position.left;
            if (!canRestoreTop || !canRestoreLeft) continue;
            element.scrollTop = position.top;
            element.scrollLeft = position.left;
            pendingScrolls.splice(index, 1);
        }
        if (pendingDetails.size === 0 && pendingDrawers.length === 0 && pendingScrolls.length === 0) finish();
    };

    tryRestore();
    if (completed) return;
    lateRestoreObserver = new MutationObserver(tryRestore);
    lateRestoreObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
    restoreInteractionHandler = finish;
    for (const eventName of ['pointerdown', 'wheel', 'touchstart', 'keydown']) {
        document.addEventListener(eventName, restoreInteractionHandler, true);
    }
    lateRestoreTimer = setTimeout(() => {
        tryRestore();
        finish();
    }, LATE_RESTORE_TIMEOUT);
}

function beginRestartStateRestore(state) {
    restorePrimaryState(state);
    restoreLateMountedUi(state);
}

function scheduleRestartStateRestore() {
    const state = readRestartState();
    if (!state) return;

    let started = false;
    const start = () => {
        if (started) return;
        started = true;
        if (restoreReadyHandler) {
            eventSource.removeListener(event_types.APP_READY, restoreReadyHandler);
            restoreReadyHandler = null;
        }
        if (restoreFallbackTimer) {
            clearTimeout(restoreFallbackTimer);
            restoreFallbackTimer = null;
        }
        requestAnimationFrame(() => beginRestartStateRestore(state));
    };

    restoreReadyHandler = start;
    eventSource.once(event_types.APP_READY, restoreReadyHandler);
    restoreFallbackTimer = setTimeout(start, 15000);
}

function showRestartOverlay(updatedExtensions) {
    document.getElementById(RESTART_OVERLAY_ID)?.remove();
    const overlay = document.createElement('div');
    overlay.id = RESTART_OVERLAY_ID;
    const card = document.createElement('div');
    card.className = 'ehr-restart-card';
    const spinner = document.createElement('i');
    spinner.className = 'fa-solid fa-arrows-rotate fa-spin';
    const title = document.createElement('strong');
    title.textContent = '扩展已更新，正在无感重启…';
    const detail = document.createElement('span');
    detail.textContent = `${updatedExtensions.filter(Boolean).join('、') || '目标扩展'} 的运行环境即将重新载入，输入内容和聊天位置会自动恢复。`;
    card.append(spinner, title, detail);
    overlay.append(card);
    document.body.append(overlay);
}

async function performSeamlessRestart(updatedExtensions) {
    if (restartPending) return;
    restartPending = true;
    try {
        const state = captureRestartState(updatedExtensions);
        sessionStorage.setItem(RESTART_STATE_KEY, JSON.stringify(state));
    } catch (error) {
        console.warn(LOG_PREFIX, 'Could not save seamless restart state:', error);
        notify('warning', '无法保存完整界面状态，但仍会自动重新载入扩展。');
    }
    showRestartOverlay(updatedExtensions);
    await new Promise((resolve) => setTimeout(resolve, 40));
    location.reload();
}

async function requestSeamlessRestart(updatedExtensions) {
    if (!settings.seamlessFallback || restartPending) return;
    if (!isGenerating()) {
        await performSeamlessRestart(updatedExtensions);
        return;
    }

    restartPending = true;
    notify('info', '检测到正在生成消息；更新已完成，将在生成结束后自动无感重启。');
    const resume = () => {
        eventSource.removeListener(event_types.GENERATION_ENDED, resume);
        eventSource.removeListener(event_types.GENERATION_STOPPED, resume);
        generationResumeHandler = null;
        restartPending = false;
        void performSeamlessRestart(updatedExtensions);
    };
    generationResumeHandler = resume;
    eventSource.once(event_types.GENERATION_ENDED, resume);
    eventSource.once(event_types.GENERATION_STOPPED, resume);
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

async function warmExtensionAssets(internalId, manifest) {
    const files = [manifest?.js, manifest?.css].filter((file, index, list) => file && list.indexOf(file) === index);
    await Promise.allSettled(files.map(async (file) => {
        const response = await fetch(buildAssetUrl(internalId, file), {
            cache: 'reload',
            credentials: 'same-origin',
        });
        if (!response.ok) throw new Error(`Could not warm ${file} (${response.status}).`);
        await response.arrayBuffer();
    }));
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
            return { status: 'up-to-date', result, displayName: oldManifest.display_name ?? externalId };
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
        const assetWarmup = !isDisabled && policy.needsPageReload
            ? warmExtensionAssets(internalId, newManifest)
            : Promise.resolve();

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

        await assetWarmup;

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
            message = settings.seamlessFallback
                ? `${newManifest.display_name ?? externalId} 的文件${styleReloaded ? '和样式' : ''}已更新；脚本没有清理钩子，将自动无感重启以安全应用。`
                : `${newManifest.display_name ?? externalId} 的文件${styleReloaded ? '和样式' : ''}已更新，但脚本没有清理钩子；为避免重复监听，本次未强制重载脚本。`;
        }
        if (!options.quiet) {
            notify(status === 'needs-page-reload' ? 'warning' : 'success', message);
        }
        return { status, result, message, displayName: newManifest.display_name ?? externalId };
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
    const summary = settings.seamlessFallback && needsReload
        ? `完成 ${results.length} 个：${hot} 个已直接应用，${needsReload} 个将通过一次无感重启应用，${failed} 个失败。`
        : `完成 ${results.length} 个：${hot} 个已直接应用，${needsReload} 个脚本需稍后刷新，${failed} 个失败。`;
    notify(failed ? 'warning' : needsReload ? 'warning' : 'success', summary, '批量热更新完成');
    if (needsReload && settings.seamlessFallback) {
        const names = results.filter((item) => item.status === 'needs-page-reload').map((item) => item.displayName);
        await requestSeamlessRestart(names);
    }
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
    if (restoreReadyHandler) {
        eventSource.removeListener(event_types.APP_READY, restoreReadyHandler);
        restoreReadyHandler = null;
    }
    if (restoreFallbackTimer) {
        clearTimeout(restoreFallbackTimer);
        restoreFallbackTimer = null;
    }
    clearLateRestoreWatchers();
    if (generationResumeHandler) {
        eventSource.removeListener(event_types.GENERATION_ENDED, generationResumeHandler);
        eventSource.removeListener(event_types.GENERATION_STOPPED, generationResumeHandler);
        generationResumeHandler = null;
    }
    managerObserver?.disconnect();
    managerObserver = null;
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(RESTART_OVERLAY_ID)?.remove();
    document.querySelectorAll(`.${BULK_BUTTON_CLASS}`).forEach((button) => button.remove());
    initialized = false;
}

function initialize() {
    if (initialized) return;
    initialized = true;
    loadSettings();
    scheduleRestartStateRestore();
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
