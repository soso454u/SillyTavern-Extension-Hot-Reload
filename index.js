import * as extensionsApi from '../../../extensions.js';
import {
    eventSource,
    event_types,
    getRequestHeaders,
    isGenerating,
    saveSettings,
    saveSettingsDebounced,
} from '../../../../script.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';
import {
    HOT_RELOAD_MODE,
    buildAssetUrl,
    classifyScriptReload,
    findCleanupHook,
    findDeletionHook,
    findLocalModuleDependencies,
    findManagedRuntimeRisks,
    findManifestStructureChanges,
    hasSelfManagedModules,
    isSameAsset,
    normalizeDrawerTitle,
    normalizeExternalId,
    resolveExtensionType,
    toInternalId,
    withCacheBuster,
} from './lib/core.js?v=1.5.2';
import { getRuntimeSupervisor } from './lib/runtime-supervisor.js?v=1.5.2';

const PLUGIN_VERSION = '1.5.2';
const MODULE_ID = 'extension_hot_reload';
const LOG_PREFIX = '[Extension Hot Reload]';
const ROOT_ID = 'extension-hot-reload-settings';
const BULK_BUTTON_CLASS = 'extension-hot-reload-all';
const RESTART_OVERLAY_ID = 'extension-hot-reload-restart-overlay';
const RESTART_STATE_KEY = 'extension-hot-reload:restart-state';
const RESTART_STATE_MAX_AGE = 2 * 60 * 1000;
const RESTART_STATE_VERSION = 3;
const LATE_RESTORE_TIMEOUT = 6000;
const REPOSITORY_REQUEST_TIMEOUT = 120000;
const ASSET_REQUEST_TIMEOUT = 15000;
const ASSET_WARMUP_BUDGET = 1250;
const MANAGER_UI_SELECTOR = '.extensions_info, .extensions_toolbar, #extensions_settings2, #extensions_settings, #extensions_settings_block';

const DEFAULT_SETTINGS = Object.freeze({
    interceptUpdateButtons: true,
    interceptDeleteButtons: true,
    showBulkButton: true,
    reloadStyles: true,
    seamlessFallback: true,
    managedReload: true,
    mode: HOT_RELOAD_MODE.SAFE,
    verboseLogging: false,
});

const { extension_settings, loadExtensionSettings } = extensionsApi;

/** @type {Map<string, object>} */
const runtimeManifests = new Map();
/** @type {Set<string>} */
const updating = new Set();
/** @type {Set<string>} */
const deleting = new Set();

let initialized = false;
const runtimeSupervisor = getRuntimeSupervisor({ eventSource, selfUrl: import.meta.url });
let managerObserver = null;
let managerUiFrame = null;
let settings = null;
let compatibilityReadyListener = null;
let restoreReadyHandler = null;
let restoreFallbackTimer = null;
let lateRestoreObserver = null;
let lateRestoreFrame = null;
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

async function getManifest(internalId) {
    const cached = runtimeManifests.get(internalId);
    if (cached) return cached;

    if (typeof extensionsApi.getExtensionManifest === 'function') {
        const manifest = extensionsApi.getExtensionManifest(internalId);
        if (manifest) return manifest;
    }

    // `getExtensionManifest` was added after lifecycle hooks. SillyTavern
    // versions without that export must still be able to load this module;
    // fetch the same manifest directly instead of making the whole static
    // import fail before the settings drawer can render.
    try {
        const manifest = await fetchFreshManifest(internalId, `compat-${Date.now()}`);
        runtimeManifests.set(internalId, manifest);
        return manifest;
    } catch (error) {
        console.warn(LOG_PREFIX, `Could not resolve manifest for ${internalId}:`, error);
        return null;
    }
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
    const host = getSettingsHost();
    if (!host) {
        log('Extension settings host was not found.');
        return false;
    }

    document.getElementById(ROOT_ID)?.remove();

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'inline-drawer ehr-container';

    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle inline-drawer-header';
    const heading = document.createElement('b');
    heading.className = 'ehr-drawer-title';
    const headingText = document.createElement('span');
    headingText.textContent = '扩展热更新';
    heading.append(headingText);
    const drawerIcon = document.createElement('div');
    drawerIcon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
    header.append(heading, drawerIcon);

    const body = document.createElement('div');
    body.className = 'inline-drawer-content ehr-body';

    const intro = document.createElement('div');
    intro.className = 'ehr-notice';
    intro.textContent = '优先使用扩展自带的清理钩子；无钩子的常规单文件扩展可由 Runtime Supervisor 托管，无法证明安全时仍会无感重启。';

    body.append(
        intro,
        checkboxRow('接管单个扩展的更新按钮', 'interceptUpdateButtons', '点击原下载图标时执行智能热更新。'),
        checkboxRow('接管扩展删除按钮', 'interceptDeleteButtons', '删除后立即卸载；不兼容脚本自动无感重启。'),
        checkboxRow('显示“智能热更新全部”', 'showBulkButton', '在扩展管理器工具栏加入一个火焰按钮。'),
        checkboxRow('立即替换样式文件', 'reloadStyles', 'CSS 可安全热替换，通常无需刷新页面。'),
        checkboxRow('自动托管式热载入', 'managedReload', '追踪可逆的事件、计时器、Observer 和 DOM；发现不可逆风险时不会强行热载入。'),
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

    const footer = document.createElement('div');
    footer.className = 'ehr-footer';
    const version = document.createElement('span');
    version.className = 'ehr-version';
    version.textContent = `v${PLUGIN_VERSION}`;
    footer.append(version);
    body.append(protocol, footer);

    root.append(header, body);
    host.append(root);
    return true;
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

function findActionButton(event, selector) {
    if (!(event.target instanceof Element)) {
        return null;
    }
    const button = event.target.closest(selector);
    return button instanceof HTMLElement ? button : null;
}

function captureUpdateClick(event) {
    const updateButton = settings?.interceptUpdateButtons
        ? findActionButton(event, '.extensions_info .extension_block .btn_update')
        : null;
    const deleteButton = settings?.interceptDeleteButtons
        ? findActionButton(event, '.extensions_info .extension_block .btn_delete')
        : null;
    const button = updateButton ?? deleteButton;
    if (!button || button.classList.contains('displayNone')) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (updateButton) {
        void updateOne(button.dataset.name, button).then((result) => {
            if (result.status === 'needs-page-reload' && settings.seamlessFallback) {
                return requestSeamlessRestart([result.displayName ?? button.dataset.name]);
            }
        });
        return;
    }
    void confirmAndDelete(button.dataset.name, button);
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

function captureOpenDrawerReferences(excludedTitles = new Set()) {
    const occurrences = new Map();
    const references = [];
    for (const drawer of document.querySelectorAll('.inline-drawer')) {
        const title = getDrawerTitle(drawer);
        const occurrence = occurrences.get(title) ?? 0;
        occurrences.set(title, occurrence + 1);
        const content = drawer.querySelector(':scope > .inline-drawer-content');
        if (!(content instanceof HTMLElement) || getComputedStyle(content).display === 'none') continue;
        if (!drawer.id && !title) continue;
        if (excludedTitles.has(title)) continue;
        references.push({ id: drawer.id || '', title, occurrence });
    }
    return references;
}

function captureScrollPositions(excludedTitles = new Set()) {
    return [...document.querySelectorAll('[id]')]
        .filter((element) => element instanceof HTMLElement
            && element.id !== 'chat'
            && !excludedTitles.has(getDrawerTitle(element.closest('.inline-drawer') ?? element))
            && (element.scrollTop !== 0 || element.scrollLeft !== 0)
            && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth))
        .slice(0, 50)
        .map((element) => ({ id: element.id, top: element.scrollTop, left: element.scrollLeft }));
}

function captureRestartState(updatedExtensions, action = 'update') {
    const textarea = document.querySelector('#send_textarea');
    const chat = document.querySelector('#chat');
    const distanceFromBottom = chat ? chat.scrollHeight - chat.clientHeight - chat.scrollTop : 0;
    const activeElement = document.activeElement;
    const excludedTitles = action === 'delete'
        ? new Set(updatedExtensions.map(normalizeDrawerTitle))
        : new Set();
    return {
        version: RESTART_STATE_VERSION,
        createdAt: Date.now(),
        path: `${location.pathname}${location.search}${location.hash}`,
        updatedExtensions: updatedExtensions.filter(Boolean).map(String),
        action,
        draft: textarea instanceof HTMLTextAreaElement ? textarea.value : '',
        selectionStart: textarea instanceof HTMLTextAreaElement ? textarea.selectionStart : null,
        selectionEnd: textarea instanceof HTMLTextAreaElement ? textarea.selectionEnd : null,
        chatScrollTop: chat instanceof HTMLElement ? chat.scrollTop : null,
        chatAtBottom: Math.abs(distanceFromBottom) < 8,
        chatAnchor: chat instanceof HTMLElement ? findVisibleChatAnchor(chat) : null,
        documentScrollX: window.scrollX,
        documentScrollY: window.scrollY,
        openDetails: [...document.querySelectorAll('details[open][id]')].map((item) => item.id),
        openInlineDrawers: captureOpenDrawerReferences(excludedTitles),
        scrollPositions: captureScrollPositions(excludedTitles),
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
    if (lateRestoreFrame !== null) {
        cancelAnimationFrame(lateRestoreFrame);
        lateRestoreFrame = null;
    }
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
        const actionText = state.action === 'delete' ? '已删除' : '已更新';
        const message = fullyRestored
            ? `${names || '扩展'} ${actionText}，输入内容和界面位置已恢复。`
            : `${names || '扩展'} ${actionText}，输入内容已恢复；为避免打断操作，已停止继续调整迟到的界面位置。`;
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

    const mutationMayHelp = (mutation) => {
        if (mutation.type !== 'childList' || mutation.addedNodes.length === 0) return false;
        const target = mutation.target instanceof Element ? mutation.target : null;
        if (target && pendingScrolls.some(({ id }) => target.id === id || target.closest(`#${CSS.escape(id)}`))) {
            return true;
        }
        if (target?.closest('.inline-drawer') && pendingDrawers.length > 0) return true;
        return [...mutation.addedNodes].some((node) => {
            if (!(node instanceof Element)) return false;
            if (pendingDetails.has(node.id) || pendingScrolls.some(({ id }) => node.id === id)) return true;
            if (pendingDrawers.length > 0 && (node.matches('.inline-drawer') || node.querySelector('.inline-drawer'))) return true;
            return [...pendingDetails].some((id) => node.querySelector(`#${CSS.escape(id)}`))
                || pendingScrolls.some(({ id }) => node.querySelector(`#${CSS.escape(id)}`));
        });
    };

    const scheduleRestore = (mutations) => {
        if (lateRestoreFrame !== null || !mutations.some(mutationMayHelp)) return;
        lateRestoreFrame = requestAnimationFrame(() => {
            lateRestoreFrame = null;
            tryRestore();
        });
    };

    tryRestore();
    if (completed) return;
    lateRestoreObserver = new MutationObserver(scheduleRestore);
    lateRestoreObserver.observe(document.body, { childList: true, subtree: true });
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

function showRestartOverlay(updatedExtensions, action = 'update') {
    document.getElementById(RESTART_OVERLAY_ID)?.remove();
    const overlay = document.createElement('div');
    overlay.id = RESTART_OVERLAY_ID;
    const card = document.createElement('div');
    card.className = 'ehr-restart-card';
    const spinner = document.createElement('i');
    spinner.className = 'fa-solid fa-arrows-rotate fa-spin';
    const title = document.createElement('strong');
    const actionText = action === 'delete' ? '删除' : '更新';
    title.textContent = `扩展已${actionText}，正在无感重启…`;
    const detail = document.createElement('span');
    detail.textContent = `${updatedExtensions.filter(Boolean).join('、') || '目标扩展'} 的运行环境即将重新载入，输入内容和聊天位置会自动恢复。`;
    card.append(spinner, title, detail);
    overlay.append(card);
    document.body.append(overlay);
}

async function performSeamlessRestart(updatedExtensions, action = 'update') {
    if (restartPending) return;
    restartPending = true;
    try {
        const state = captureRestartState(updatedExtensions, action);
        sessionStorage.setItem(RESTART_STATE_KEY, JSON.stringify(state));
    } catch (error) {
        console.warn(LOG_PREFIX, 'Could not save seamless restart state:', error);
        notify('warning', '无法保存完整界面状态，但仍会自动重新载入扩展。');
    }
    showRestartOverlay(updatedExtensions, action);
    await new Promise((resolve) => setTimeout(resolve, 40));
    location.reload();
}

async function requestSeamlessRestart(updatedExtensions, action = 'update') {
    if (!settings.seamlessFallback || restartPending) return;
    if (!isGenerating()) {
        await performSeamlessRestart(updatedExtensions, action);
        return;
    }

    restartPending = true;
    notify('info', `检测到正在生成消息；扩展已${action === 'delete' ? '删除' : '更新'}，将在生成结束后自动无感重启。`);
    const resume = () => {
        eventSource.removeListener(event_types.GENERATION_ENDED, resume);
        eventSource.removeListener(event_types.GENERATION_STOPPED, resume);
        generationResumeHandler = null;
        restartPending = false;
        void performSeamlessRestart(updatedExtensions, action);
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
    return promiseWithTimeout(import(url), ASSET_REQUEST_TIMEOUT, 'Extension module import timed out.');
}

function promiseWithTimeout(promise, milliseconds, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function invokeManifestHook(moduleNamespace, manifest, hookName, context) {
    const exportName = manifest?.hooks?.[hookName];
    const fn = typeof exportName === 'string' ? moduleNamespace?.[exportName] : undefined;
    if (typeof fn !== 'function') {
        return false;
    }
    await promiseWithTimeout(Promise.resolve(fn(context)), 5000, `${hookName} hook timed out.`);
    return true;
}

function timeoutSignal(milliseconds) {
    if (typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(milliseconds);
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(), milliseconds);
    return controller.signal;
}

async function fetchFreshManifest(internalId, token) {
    const url = withCacheBuster(buildAssetUrl(internalId, 'manifest.json'), token);
    const response = await fetch(url, {
        cache: 'no-store',
        signal: timeoutSignal(ASSET_REQUEST_TIMEOUT),
    });
    if (!response.ok) {
        throw new Error(`Could not load the updated manifest (${response.status}).`);
    }
    const manifest = await response.json();
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('The updated manifest is invalid.');
    }
    return manifest;
}

async function evictExtensionAssetCaches(internalId) {
    if (!('caches' in globalThis)) return 0;
    const manifestPath = new URL(buildAssetUrl(internalId, 'manifest.json'), location.origin).pathname;
    const extensionPrefix = manifestPath.slice(0, -'manifest.json'.length);
    let deleted = 0;

    try {
        const cacheResults = await Promise.all((await caches.keys()).map(async (cacheName) => {
            const cache = await caches.open(cacheName);
            const matches = (await cache.keys()).filter((request) => {
                const url = new URL(request.url);
                return url.origin === location.origin && url.pathname.startsWith(extensionPrefix);
            });
            const results = await Promise.allSettled(matches.map((request) => cache.delete(request)));
            return results.filter((result) => result.status === 'fulfilled' && result.value).length;
        }));
        deleted = cacheResults.reduce((total, count) => total + count, 0);
    } catch (error) {
        console.warn(LOG_PREFIX, `Could not clear cached assets for ${internalId}:`, error);
    }
    log('Evicted cached extension assets', { internalId, deleted });
    return deleted;
}

async function fetchExtensionEntrySource(internalId, manifest, token = '') {
    if (!manifest?.js) return { entryUrl: null, source: '' };
    const baseUrl = buildAssetUrl(internalId, manifest.js);
    const entryUrl = new URL(token ? withCacheBuster(baseUrl, token) : baseUrl, location.origin);
    const manifestUrl = new URL(buildAssetUrl(internalId, 'manifest.json'), location.origin);
    const response = await fetch(entryUrl, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: timeoutSignal(ASSET_REQUEST_TIMEOUT),
    });
    if (!response.ok) {
        throw new Error(`Could not inspect extension entry (${response.status}).`);
    }
    return { entryUrl, manifestUrl, source: await response.text() };
}

async function inspectExtensionEntry(internalId, manifest, token = '') {
    const inspection = await fetchExtensionEntrySource(internalId, manifest, token);
    if (!inspection.entryUrl) return { source: '', localDependencies: [], risks: [] };
    return {
        source: inspection.source,
        localDependencies: findLocalModuleDependencies(
            inspection.source,
            inspection.entryUrl,
            new URL('./', inspection.manifestUrl),
        ),
        risks: findManagedRuntimeRisks(inspection.source),
    };
}

async function assessManagedRuntime(internalId, manifest, isDisabled, cleanupHook) {
    const snapshot = runtimeSupervisor?.getSnapshot(internalId) ?? null;
    const assessment = {
        eligible: false,
        snapshot,
        risks: [],
        reason: 'not-requested',
    };
    if (!settings.managedReload || isDisabled || !manifest?.js || cleanupHook) return assessment;
    if (!snapshot?.eligible) {
        assessment.reason = !snapshot?.coverageComplete
            ? 'tracker-started-too-late'
            : snapshot?.opaqueReasons?.length ? 'opaque-runtime-effects' : 'runtime-ledger-incomplete';
        return assessment;
    }
    try {
        const inspection = await inspectExtensionEntry(internalId, manifest, `managed-audit-${Date.now()}`);
        assessment.risks = inspection.risks;
        assessment.eligible = inspection.risks.length === 0;
        assessment.reason = assessment.eligible ? 'managed-runtime' : 'source-risk-detected';
    } catch (error) {
        assessment.reason = 'source-audit-failed';
        assessment.error = error;
    }
    return assessment;
}

async function warmExtensionAssets(internalId, manifest) {
    const files = [manifest?.js, manifest?.css].filter((file, index, list) => file && list.indexOf(file) === index);
    if (files.length === 0) return;
    const controller = new AbortController();
    let budgetTimer;
    const warmup = Promise.allSettled(files.map(async (file) => {
        const response = await fetch(buildAssetUrl(internalId, file), {
            cache: 'reload',
            credentials: 'same-origin',
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Could not warm ${file} (${response.status}).`);
        await response.arrayBuffer();
    }));
    const budget = new Promise((resolve) => {
        budgetTimer = setTimeout(() => {
            controller.abort();
            resolve('budget-exhausted');
        }, ASSET_WARMUP_BUDGET);
    });
    const outcome = await Promise.race([warmup.then(() => 'complete'), budget]);
    if (outcome === 'complete') clearTimeout(budgetTimer);
    log('Extension asset warmup finished', { internalId, outcome });
}

async function updateRepository(externalId, isGlobal) {
    const response = await fetch('/api/extensions/update', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ extensionName: externalId, global: isGlobal }),
        signal: timeoutSignal(REPOSITORY_REQUEST_TIMEOUT),
    });
    if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Extension update failed (${response.status}).`);
    }
    return response.json();
}

async function deleteRepository(externalId, isGlobal) {
    const response = await fetch('/api/extensions/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ extensionName: externalId, global: isGlobal }),
        signal: timeoutSignal(REPOSITORY_REQUEST_TIMEOUT),
    });
    if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Extension deletion failed (${response.status}).`);
    }
}

function removeExtensionStyles(internalId, manifest) {
    if (!manifest?.css) return;
    const assetUrl = buildAssetUrl(internalId, manifest.css);
    document.querySelectorAll('link[rel="stylesheet"][href]').forEach((link) => {
        if (isSameAsset(link.href, assetUrl)) link.remove();
    });
}

function removeManagerRows(externalId) {
    document.querySelectorAll('.extension_block').forEach((block) => {
        if (block.dataset.name === externalId) block.remove();
    });
}

async function confirmAndDelete(rawId, button) {
    let externalId;
    try {
        externalId = normalizeExternalId(rawId);
    } catch (error) {
        notify('error', error.message);
        return;
    }
    if (deleting.has(externalId) || updating.has(externalId)) return;

    const internalId = toInternalId(externalId);
    const manifest = await getManifest(internalId);
    if (!manifest) {
        notify('error', `找不到 ${externalId} 的 manifest。`);
        return;
    }

    const displayName = manifest.display_name ?? externalId;
    const hasCleanHook = typeof manifest?.hooks?.clean === 'string' && manifest.hooks.clean.length > 0;
    const customInputs = hasCleanHook
        ? [{ id: 'extension_delete_cleanup', label: '同时清理扩展保存的数据', defaultState: false }]
        : null;
    const popup = new Popup(`确定要删除 ${escapeHtml(displayName)} 吗？`, POPUP_TYPE.CONFIRM, '', { customInputs });
    const confirmation = await popup.show();
    if (confirmation !== POPUP_RESULT.AFFIRMATIVE) return;

    const shouldClean = hasCleanHook && Boolean(popup.inputResults?.get('extension_delete_cleanup'));
    const isDisabled = extension_settings.disabledExtensions?.includes(internalId) ?? false;
    const isGlobal = resolveExtensionType(extensionsApi.extensionTypes, externalId) === 'global';
    let oldModule = null;
    const hasDeleteHook = typeof manifest?.hooks?.delete === 'string' && manifest.hooks.delete.length > 0;
    const needsHookModule = !isDisabled || hasDeleteHook || (shouldClean && hasCleanHook);
    if (needsHookModule && manifest.js) {
        try {
            oldModule = await importExtensionModule(internalId, manifest);
        } catch (error) {
            console.warn(LOG_PREFIX, `Could not import ${externalId} before deletion:`, error);
        }
    }
    const deletionHook = oldModule ? findDeletionHook(manifest, oldModule) : null;
    const cleanupHook = oldModule ? findCleanupHook(manifest, oldModule) : null;
    let runtimeDisposed = isDisabled || !manifest.js;
    let disposalAttempted = false;
    const hookContext = Object.freeze({
        reason: 'extension-delete',
        extensionName: internalId,
        manifest: structuredClone(manifest),
    });

    let repositoryDeleted = false;
    deleting.add(externalId);
    button?.setAttribute('disabled', 'disabled');
    button?.querySelector('i')?.classList.add('fa-spin');
    try {
        if (shouldClean && oldModule) {
            try {
                await invokeManifestHook(oldModule, manifest, 'clean', hookContext);
            } catch (hookError) {
                console.error(LOG_PREFIX, `Clean hook failed for ${externalId}:`, hookError);
            }
        }
        let deletionHookSucceeded = false;
        if (deletionHook) {
            try {
                await promiseWithTimeout(
                    Promise.resolve(deletionHook.fn(hookContext)),
                    5000,
                    `${deletionHook.name} hook timed out.`,
                );
                deletionHookSucceeded = true;
            } catch (hookError) {
                console.error(LOG_PREFIX, `Deletion hook failed for ${externalId}:`, hookError);
            }
        }
        if (!runtimeDisposed && cleanupHook) {
            disposalAttempted = true;
            if (cleanupHook.fn === deletionHook?.fn && deletionHookSucceeded) {
                runtimeDisposed = true;
            } else {
                try {
                    await promiseWithTimeout(
                        Promise.resolve(cleanupHook.fn(hookContext)),
                        5000,
                        `${cleanupHook.name} hook timed out.`,
                    );
                    runtimeDisposed = true;
                } catch (hookError) {
                    console.error(LOG_PREFIX, `Runtime cleanup hook failed for ${externalId}:`, hookError);
                }
            }
        }

        await deleteRepository(externalId, isGlobal);
        repositoryDeleted = true;
        removeExtensionStyles(internalId, manifest);
        removeManagerRows(externalId);
        runtimeManifests.delete(internalId);
        extension_settings.disabledExtensions = (extension_settings.disabledExtensions ?? []).filter((name) => name !== internalId);
        await saveSettings();
        await loadExtensionSettings({}, false, false);

        if (runtimeDisposed) {
            notify('success', `${displayName} 已删除，并已从当前页面卸载。`, '扩展删除完成');
        } else if (settings.seamlessFallback) {
            notify('warning', `${displayName} 已删除；旧脚本无法安全卸载，将自动无感重启。`, '扩展删除完成');
            await requestSeamlessRestart([displayName], 'delete');
        } else {
            notify('warning', `${displayName} 已删除，但旧脚本会保留到下次刷新页面。`, '扩展删除完成');
        }
    } catch (error) {
        console.error(LOG_PREFIX, `Failed to delete ${externalId}:`, error);
        if (!repositoryDeleted && disposalAttempted && !isDisabled && oldModule) {
            try {
                await invokeManifestHook(oldModule, manifest, 'activate', { ...hookContext, reason: 'extension-delete-rollback' });
            } catch (rollbackError) {
                console.error(LOG_PREFIX, 'Deletion rollback failed:', rollbackError);
            }
        }
        if (repositoryDeleted) {
            const message = settings.seamlessFallback
                ? `${displayName} 已删除，但页面状态同步失败，将通过无感重启完成清理。`
                : `${displayName} 已删除，但页面状态同步失败；请稍后手动刷新一次。`;
            notify('warning', message, '扩展删除完成');
            if (settings.seamlessFallback) {
                await requestSeamlessRestart([displayName], 'delete');
            }
        } else {
            notify('error', `${displayName} 删除失败：${error.message}`, '扩展删除失败');
        }
    } finally {
        deleting.delete(externalId);
        button?.removeAttribute('disabled');
        button?.querySelector('i')?.classList.remove('fa-spin');
    }
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
    try {
        await promiseWithTimeout(new Promise((resolve, reject) => {
            link.addEventListener('load', resolve, { once: true });
            link.addEventListener('error', () => reject(new Error('Updated stylesheet failed to load.')), { once: true });
            document.head.append(link);
        }), ASSET_REQUEST_TIMEOUT, 'Updated stylesheet load timed out.');
    } catch (error) {
        link.remove();
        throw error;
    }
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
    const oldManifest = await getManifest(internalId);
    if (!oldManifest) {
        const error = new Error(`找不到 ${externalId} 的 manifest。`);
        notify('error', error.message);
        return { status: 'failed', error };
    }

    updating.add(externalId);
    button?.setAttribute('disabled', 'disabled');
    button?.querySelector('i')?.classList.add('fa-spin');

    let repositoryUpdated = false;
    let runtimeTouched = false;
    let result = null;
    let newManifest = null;

    try {
        const isGlobal = resolveExtensionType(extensionsApi.extensionTypes, externalId) === 'global';
        const isDisabled = extension_settings.disabledExtensions?.includes(internalId) ?? false;
        const oldModule = !isDisabled && oldManifest.js
            ? await importExtensionModule(internalId, oldManifest)
            : null;
        const cleanupHook = oldModule ? findCleanupHook(oldManifest, oldModule) : null;
        const managedAssessment = await assessManagedRuntime(internalId, oldManifest, isDisabled, cleanupHook);
        let policy = classifyScriptReload({
            hasScript: Boolean(oldManifest.js),
            isDisabled,
            hasCleanupHook: Boolean(cleanupHook),
            hasManagedRuntime: managedAssessment.eligible,
            mode: settings.mode,
        });

        log('Updating', {
            externalId,
            isGlobal,
            policy,
            cleanupHook: cleanupHook?.name,
            managedAssessment,
        });
        result = await updateRepository(externalId, isGlobal);
        if (result.isUpToDate) {
            if (!options.quiet) notify('success', `${oldManifest.display_name ?? externalId} 已经是最新版本。`);
            updateManagerRow(externalId, oldManifest, result.shortCommitHash);
            return { status: 'up-to-date', result, displayName: oldManifest.display_name ?? externalId };
        }
        repositoryUpdated = true;

        const token = `${result.shortCommitHash ?? 'updated'}-${Date.now()}`;
        await evictExtensionAssetCaches(internalId);
        newManifest = await fetchFreshManifest(internalId, token);
        const manifestStructureChanges = findManifestStructureChanges(oldManifest, newManifest);
        if (manifestStructureChanges.length > 0) {
            policy = { reloadScript: false, needsPageReload: true, reason: 'manifest-structure-changed' };
            log('Manifest structure changes require a seamless restart', { externalId, manifestStructureChanges });
        }
        if (!isDisabled && policy.reloadScript) {
            try {
                const inspection = await inspectExtensionEntry(internalId, newManifest, token);
                const localDependencies = inspection.localDependencies;
                if (policy.reason === 'managed' && inspection.risks.length > 0) {
                    policy = { reloadScript: false, needsPageReload: true, reason: 'managed-source-risk' };
                    log('Updated source is not eligible for managed reload', { externalId, risks: inspection.risks });
                } else if (localDependencies.length > 0) {
                    if (hasSelfManagedModules(newManifest)) {
                        log('Extension opted into self-managed local modules', { externalId, localDependencies });
                    } else {
                        policy = { reloadScript: false, needsPageReload: true, reason: 'multi-file-module' };
                        log('Local module dependencies require a seamless restart', { externalId, localDependencies });
                    }
                }
            } catch (inspectionError) {
                console.warn(LOG_PREFIX, `Could not inspect module dependencies for ${externalId}:`, inspectionError);
                policy = { reloadScript: false, needsPageReload: true, reason: 'module-inspection-failed' };
            }
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
            if (policy.reason === 'managed') {
                runtimeTouched = true;
                const disposal = await runtimeSupervisor.dispose(internalId);
                log('Managed runtime disposed', { externalId, disposal });
                if (!disposal.complete) {
                    throw new Error(`Managed runtime cleanup was incomplete: ${disposal.failures.join('; ')}`);
                }
            } else if (cleanupHook) {
                runtimeTouched = true;
                await promiseWithTimeout(
                    Promise.resolve(cleanupHook.fn(hookContext)),
                    5000,
                    `${cleanupHook.name} hook timed out.`,
                );
                runtimeSupervisor?.discard(internalId);
            }
            try {
                runtimeTouched = true;
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
        } else if (oldModule && !policy.needsPageReload) {
            runtimeTouched = true;
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
        if (policy.needsPageReload) {
            status = 'needs-page-reload';
            const reloadReason = policy.reason === 'multi-file-module'
                ? '检测到本地子模块，为避免浏览器复用旧模块缓存'
                : policy.reason === 'module-inspection-failed'
                    ? '无法确认本地子模块是否全部换新'
                    : policy.reason === 'manifest-structure-changed'
                        ? 'manifest 运行结构已变化，需要让 SillyTavern 重建扩展状态'
                        : policy.reason === 'managed-source-risk'
                            ? '新版脚本包含无法可靠回收的运行时操作'
                            : '脚本没有清理钩子';
            message = settings.seamlessFallback
                ? `${newManifest.display_name ?? externalId} 的文件${styleReloaded ? '和样式' : ''}已更新；${reloadReason}，将自动无感重启以安全应用。`
                : `${newManifest.display_name ?? externalId} 的文件${styleReloaded ? '和样式' : ''}已更新；${reloadReason}，请稍后刷新页面。`;
        } else if (isDisabled) {
            status = 'updated-disabled';
            message = `${newManifest.display_name ?? externalId} 已更新；它当前未启用，不需要重载运行中的脚本。`;
        } else if (scriptReloaded) {
            status = policy.reason === 'forced'
                ? 'force-reloaded'
                : policy.reason === 'managed' ? 'managed-reloaded' : 'hot-reloaded';
            const method = policy.reason === 'managed' ? '并由 Runtime Supervisor 完成托管换新' : '并热载入';
            message = `${newManifest.display_name ?? externalId} 已更新${method}${styleReloaded ? '（含样式）' : ''}。`;
        } else if (!oldManifest.js) {
            status = 'style-reloaded';
            message = `${newManifest.display_name ?? externalId} 已更新${styleReloaded ? '，样式已立即生效' : ''}。`;
        } else {
            message = `${newManifest.display_name ?? externalId} 的文件已更新。`;
        }
        if (!options.quiet) {
            notify(status === 'needs-page-reload' ? 'warning' : 'success', message);
        }
        return { status, result, message, displayName: newManifest.display_name ?? externalId };
    } catch (error) {
        console.error(LOG_PREFIX, `Failed to update ${externalId}:`, error);
        if (repositoryUpdated) {
            const displayName = newManifest?.display_name ?? oldManifest.display_name ?? externalId;
            if (newManifest) {
                runtimeManifests.set(internalId, newManifest);
                updateManagerRow(externalId, newManifest, result?.shortCommitHash);
            }
            const recovery = settings.seamlessFallback
                ? '热载入未能安全完成，已自动切换无感重启恢复干净运行环境。'
                : '热载入未能安全完成，请刷新页面以恢复干净运行环境。';
            const message = `${displayName} 的 Git 更新已完成；${recovery}`;
            log('Post-update failure requires a clean runtime', { externalId, runtimeTouched, error });
            if (!options.quiet) notify('warning', message);
            return {
                status: 'needs-page-reload',
                result,
                error,
                message,
                displayName,
                recoveryReason: runtimeTouched ? 'runtime-touched' : 'post-update-failure',
            };
        }
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
    const targets = [...document.querySelectorAll('.extensions_info .extension_block .btn_update:not(.displayNone)')]
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
    const hot = results.filter((item) => ['hot-reloaded', 'managed-reloaded', 'force-reloaded', 'style-reloaded', 'updated-disabled'].includes(item.status)).length;
    const summary = settings.seamlessFallback && needsReload
        ? `完成 ${results.length} 个：${hot} 个已直接应用，${needsReload} 个将通过一次无感重启应用，${failed} 个失败。`
        : `完成 ${results.length} 个：${hot} 个已直接应用，${needsReload} 个脚本需稍后刷新，${failed} 个失败。`;
    notify(failed ? 'warning' : needsReload ? 'warning' : 'success', summary, '批量热更新完成');
    if (needsReload && settings.seamlessFallback) {
        const names = results.filter((item) => item.status === 'needs-page-reload').map((item) => item.displayName);
        await requestSeamlessRestart(names);
    }
}

function scheduleEnsureUi() {
    if (managerUiFrame !== null) return;
    managerUiFrame = requestAnimationFrame(() => {
        managerUiFrame = null;
        ensureUi();
    });
}

function mutationContainsManagerUi(mutation) {
    if (mutation.type !== 'childList') return false;
    // During a first-time installation SillyTavern can import this module
    // before its extension settings host has been mounted. Any later DOM
    // mutation that makes the host available must get one chance to attach
    // the drawer, even if the added wrapper is not itself a manager node.
    if (!document.getElementById(ROOT_ID) && getSettingsHost()) return true;
    if (mutation.target instanceof Element && mutation.target.matches(MANAGER_UI_SELECTOR)) return true;
    return [...mutation.addedNodes].some((node) => node instanceof Element
        && (node.matches(MANAGER_UI_SELECTOR) || node.querySelector(MANAGER_UI_SELECTOR)));
}

function startObserver() {
    managerObserver?.disconnect();
    managerObserver = new MutationObserver((mutations) => {
        if (mutations.some(mutationContainsManagerUi)) scheduleEnsureUi();
    });
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
    if (managerUiFrame !== null) {
        cancelAnimationFrame(managerUiFrame);
        managerUiFrame = null;
    }
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(RESTART_OVERLAY_ID)?.remove();
    document.querySelectorAll(`.${BULK_BUTTON_CLASS}`).forEach((button) => button.remove());
    initialized = false;
}

function initialize() {
    if (initialized) return;
    initialized = true;
    loadSettings();
    log('Runtime Supervisor status', runtimeSupervisor.getStatus());
    scheduleRestartStateRestore();
    renderSettings();
    document.addEventListener('click', captureUpdateClick, true);
    startObserver();
    console.info(LOG_PREFIX, 'Loaded.');
}

export function onActivate() {
    initialize();
}

export function onInstall() {
    initialize();
    ensureUi();
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
// not invoke manifest activation hooks yet. Install/activate and this fallback
// can run in either order because the initializer is idempotent.
if (document.readyState === 'loading') {
    compatibilityReadyListener = initialize;
    document.addEventListener('DOMContentLoaded', compatibilityReadyListener, { once: true });
} else {
    queueMicrotask(initialize);
}
