const SUPERVISOR_SYMBOL = Symbol.for('sillytavern.extension-hot-reload.runtime-supervisor');

/**
 * Resolve an extension owner from one module URL.
 * @param {unknown} value
 * @returns {string}
 */
export function extensionOwnerFromUrl(value) {
    let text = String(value ?? '');
    try {
        text = decodeURIComponent(text);
    } catch {
        // Keep the undecoded URL when a stack contains malformed escapes.
    }
    const match = text.match(/\/scripts\/extensions\/(third-party\/[^/?#\s):]+)/i);
    return match?.[1] ?? '';
}

/**
 * Resolve the first third-party extension frame in an Error stack.
 * @param {unknown} stack
 * @param {string} selfOwner
 * @returns {string}
 */
export function extensionOwnerFromStack(stack, selfOwner = '') {
    for (const line of String(stack ?? '').split('\n')) {
        const owner = extensionOwnerFromUrl(line);
        if (owner && owner !== selfOwner) return owner;
    }
    return '';
}

function captureValue(value) {
    if (value == null) return value;
    if (typeof value === 'boolean') return value;
    return Boolean(value.capture);
}

class RuntimeSupervisor {
    constructor(root, selfOwner) {
        this.root = root;
        this.selfOwner = selfOwner;
        this.currentOwner = '';
        this.suppressionDepth = 0;
        this.installed = false;
        this.coverageComplete = false;
        this.patchFailures = [];
        this.ledgers = new Map();
        this.nodeOwners = new WeakMap();
        this.patchedEventBuses = new WeakSet();
        this.eventBusCaptureDepth = 0;
    }

    install(eventBus) {
        if (!this.installed) {
            this.coverageComplete = this.findPreviouslyLoadedOwners().length === 0;
            this.patchEventTargets();
            this.patchTimers();
            this.patchFetch();
            this.patchObservers();
            this.patchPersistentResources();
            this.patchJQuery();
            this.patchDomInsertion();
            this.installed = true;
        }
        this.patchEventBus(eventBus);
        return this;
    }

    findPreviouslyLoadedOwners() {
        const document = this.root.document;
        if (!document?.querySelectorAll) return [];
        return [...document.querySelectorAll('script[type="module"][src*="/scripts/extensions/third-party/"]')]
            .map((script) => extensionOwnerFromUrl(script.src))
            .filter((owner) => owner && owner !== this.selfOwner);
    }

    resolveOwner() {
        if (this.suppressionDepth > 0) return '';
        if (this.currentOwner && this.currentOwner !== this.selfOwner) return this.currentOwner;
        return extensionOwnerFromStack(new Error().stack, this.selfOwner);
    }

    runWithOwner(owner, callback, thisArg, args = []) {
        const previousOwner = this.currentOwner;
        this.currentOwner = owner;
        try {
            return Reflect.apply(callback, thisArg, args);
        } finally {
            this.currentOwner = previousOwner;
        }
    }

    withoutNestedTracking(callback) {
        this.suppressionDepth++;
        try {
            return callback();
        } finally {
            this.suppressionDepth--;
        }
    }

    getLedger(owner) {
        let ledger = this.ledgers.get(owner);
        if (!ledger) {
            ledger = {
                owner,
                createdAt: Date.now(),
                everTracked: false,
                resources: [],
                opaqueReasons: new Set(),
            };
            this.ledgers.set(owner, ledger);
        }
        return ledger;
    }

    track(owner, kind, cleanup, meta = {}) {
        if (!owner || owner === this.selfOwner || typeof cleanup !== 'function') return null;
        const ledger = this.getLedger(owner);
        const resource = {
            owner,
            kind,
            cleanup,
            meta,
            active: true,
            sequence: ledger.resources.length,
        };
        ledger.everTracked = true;
        ledger.resources.push(resource);
        return resource;
    }

    deactivate(resource) {
        if (resource) resource.active = false;
    }

    deactivateWhere(predicate) {
        for (const ledger of this.ledgers.values()) {
            for (const resource of ledger.resources) {
                if (resource.active && predicate(resource)) resource.active = false;
            }
        }
    }

    markOpaque(owner, reason) {
        if (!owner || owner === this.selfOwner) return;
        this.getLedger(owner).opaqueReasons.add(reason);
    }

    getSnapshot(owner) {
        const ledger = this.ledgers.get(owner);
        const activeResources = ledger?.resources.filter((resource) => resource.active) ?? [];
        const counts = {};
        for (const resource of activeResources) {
            counts[resource.kind] = (counts[resource.kind] ?? 0) + 1;
        }
        const opaqueReasons = [...(ledger?.opaqueReasons ?? [])];
        const eligible = this.coverageComplete
            && this.patchFailures.length === 0
            && Boolean(ledger?.everTracked)
            && activeResources.length > 0
            && opaqueReasons.length === 0;
        return {
            owner,
            installed: this.installed,
            coverageComplete: this.coverageComplete,
            patchFailures: [...this.patchFailures],
            everTracked: Boolean(ledger?.everTracked),
            activeResources: activeResources.length,
            counts,
            opaqueReasons,
            eligible,
        };
    }

    getStatus() {
        return {
            installed: this.installed,
            coverageComplete: this.coverageComplete,
            patchFailures: [...this.patchFailures],
            trackedOwners: [...this.ledgers.keys()],
        };
    }

    discard(owner) {
        this.ledgers.delete(owner);
    }

    async dispose(owner) {
        const ledger = this.ledgers.get(owner);
        if (!ledger) {
            return { complete: false, cleaned: 0, failures: ['runtime-ledger-missing'], counts: {} };
        }
        const resources = ledger.resources
            .filter((resource) => resource.active)
            .sort((left, right) => right.sequence - left.sequence);
        const counts = {};
        const failures = [];
        let cleaned = 0;
        for (const resource of resources) {
            resource.active = false;
            try {
                await resource.cleanup();
                cleaned++;
                counts[resource.kind] = (counts[resource.kind] ?? 0) + 1;
            } catch (error) {
                failures.push(`${resource.kind}: ${error?.message ?? error}`);
            }
        }
        this.ledgers.delete(owner);
        return { complete: failures.length === 0, cleaned, failures, counts };
    }

    assignPatch(target, key, replacement, label) {
        try {
            target[key] = replacement;
            if (target[key] !== replacement) throw new Error('assignment was ignored');
        } catch (error) {
            this.patchFailures.push(`${label}: ${error?.message ?? error}`);
        }
    }

    patchEventTargets() {
        const prototype = this.root.EventTarget?.prototype;
        if (!prototype?.addEventListener || !prototype?.removeEventListener) return;
        const supervisor = this;
        const originalAdd = prototype.addEventListener;
        const originalRemove = prototype.removeEventListener;

        function addEventListener(type, listener, options) {
            const owner = supervisor.resolveOwner();
            const result = Reflect.apply(originalAdd, this, arguments);
            if (owner && listener) {
                supervisor.track(owner, 'dom-listener', () => {
                    Reflect.apply(originalRemove, this, [type, listener, captureValue(options)]);
                }, { target: this, type, listener, capture: captureValue(options) });
            }
            return result;
        }

        function removeEventListener(type, listener, options) {
            const capture = captureValue(options);
            const result = Reflect.apply(originalRemove, this, arguments);
            supervisor.deactivateWhere((resource) => resource.kind === 'dom-listener'
                && resource.meta.target === this
                && resource.meta.type === type
                && resource.meta.listener === listener
                && resource.meta.capture === capture);
            return result;
        }

        this.assignPatch(prototype, 'addEventListener', addEventListener, 'EventTarget.addEventListener');
        this.assignPatch(prototype, 'removeEventListener', removeEventListener, 'EventTarget.removeEventListener');
    }

    patchTimers() {
        const supervisor = this;
        const root = this.root;
        const originalSetTimeout = root.setTimeout;
        const originalClearTimeout = root.clearTimeout;
        const originalSetInterval = root.setInterval;
        const originalClearInterval = root.clearInterval;

        if (typeof originalSetTimeout === 'function' && typeof originalClearTimeout === 'function') {
            function setTimeout(callback, delay, ...args) {
                const owner = supervisor.resolveOwner();
                if (!owner || typeof callback !== 'function') {
                    return Reflect.apply(originalSetTimeout, root, [callback, delay, ...args]);
                }
                let resource;
                const wrapped = function (...callbackArgs) {
                    supervisor.deactivate(resource);
                    return supervisor.runWithOwner(owner, callback, this, callbackArgs);
                };
                const id = Reflect.apply(originalSetTimeout, root, [wrapped, delay, ...args]);
                resource = supervisor.track(owner, 'timeout', () => Reflect.apply(originalClearTimeout, root, [id]), { id });
                return id;
            }
            function clearTimeout(id) {
                supervisor.deactivateWhere((resource) => resource.kind === 'timeout' && resource.meta.id === id);
                return Reflect.apply(originalClearTimeout, root, [id]);
            }
            this.assignPatch(root, 'setTimeout', setTimeout, 'setTimeout');
            this.assignPatch(root, 'clearTimeout', clearTimeout, 'clearTimeout');
        }

        if (typeof originalSetInterval === 'function' && typeof originalClearInterval === 'function') {
            function setInterval(callback, delay, ...args) {
                const owner = supervisor.resolveOwner();
                if (!owner || typeof callback !== 'function') {
                    return Reflect.apply(originalSetInterval, root, [callback, delay, ...args]);
                }
                const wrapped = function (...callbackArgs) {
                    return supervisor.runWithOwner(owner, callback, this, callbackArgs);
                };
                const id = Reflect.apply(originalSetInterval, root, [wrapped, delay, ...args]);
                supervisor.track(owner, 'interval', () => Reflect.apply(originalClearInterval, root, [id]), { id });
                return id;
            }
            function clearInterval(id) {
                supervisor.deactivateWhere((resource) => resource.kind === 'interval' && resource.meta.id === id);
                return Reflect.apply(originalClearInterval, root, [id]);
            }
            this.assignPatch(root, 'setInterval', setInterval, 'setInterval');
            this.assignPatch(root, 'clearInterval', clearInterval, 'clearInterval');
        }

        const originalRequestAnimationFrame = root.requestAnimationFrame;
        const originalCancelAnimationFrame = root.cancelAnimationFrame;
        if (typeof originalRequestAnimationFrame === 'function' && typeof originalCancelAnimationFrame === 'function') {
            function requestAnimationFrame(callback) {
                const owner = supervisor.resolveOwner();
                if (!owner || typeof callback !== 'function') {
                    return Reflect.apply(originalRequestAnimationFrame, root, [callback]);
                }
                let resource;
                const wrapped = function (...callbackArgs) {
                    supervisor.deactivate(resource);
                    return supervisor.runWithOwner(owner, callback, this, callbackArgs);
                };
                const id = Reflect.apply(originalRequestAnimationFrame, root, [wrapped]);
                resource = supervisor.track(owner, 'animation-frame', () => Reflect.apply(originalCancelAnimationFrame, root, [id]), { id });
                return id;
            }
            function cancelAnimationFrame(id) {
                supervisor.deactivateWhere((resource) => resource.kind === 'animation-frame' && resource.meta.id === id);
                return Reflect.apply(originalCancelAnimationFrame, root, [id]);
            }
            this.assignPatch(root, 'requestAnimationFrame', requestAnimationFrame, 'requestAnimationFrame');
            this.assignPatch(root, 'cancelAnimationFrame', cancelAnimationFrame, 'cancelAnimationFrame');
        }
    }

    patchFetch() {
        const root = this.root;
        const originalFetch = root.fetch;
        const AbortControllerClass = root.AbortController;
        if (typeof originalFetch !== 'function' || typeof AbortControllerClass !== 'function') return;
        const supervisor = this;

        function fetch(input, init) {
            const owner = supervisor.resolveOwner();
            if (!owner) return Reflect.apply(originalFetch, this, arguments);

            const controller = new AbortControllerClass();
            const existingSignal = init?.signal ?? input?.signal;
            let signal = controller.signal;
            let detachExistingSignal = null;
            if (existingSignal) {
                if (typeof root.AbortSignal?.any === 'function') {
                    signal = root.AbortSignal.any([existingSignal, controller.signal]);
                } else if (existingSignal.aborted) {
                    controller.abort(existingSignal.reason);
                } else if (typeof existingSignal.addEventListener === 'function') {
                    const forwardAbort = () => controller.abort(existingSignal.reason);
                    existingSignal.addEventListener('abort', forwardAbort, { once: true });
                    detachExistingSignal = () => existingSignal.removeEventListener?.('abort', forwardAbort);
                }
            }

            let resource;
            let request;
            try {
                request = Reflect.apply(originalFetch, this, [input, { ...init, signal }]);
                resource = supervisor.track(owner, 'fetch', () => controller.abort('extension-hot-reload'), {
                    controller,
                    input,
                });
            } catch (error) {
                detachExistingSignal?.();
                throw error;
            }
            return Promise.resolve(request).finally(() => {
                detachExistingSignal?.();
                supervisor.deactivate(resource);
            });
        }

        this.assignPatch(root, 'fetch', fetch, 'fetch');
    }

    patchObservers() {
        for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
            const Original = this.root[name];
            if (typeof Original !== 'function') continue;
            const supervisor = this;
            let Patched;
            Patched = new Proxy(Original, {
                construct(target, args, newTarget) {
                    const owner = supervisor.resolveOwner();
                    const callback = args[0];
                    const wrapped = owner && typeof callback === 'function'
                        ? function (...callbackArgs) {
                            return supervisor.runWithOwner(owner, callback, this, callbackArgs);
                        }
                        : callback;
                    const actualNewTarget = newTarget === Patched ? target : newTarget;
                    const instance = Reflect.construct(target, [wrapped, ...args.slice(1)], actualNewTarget);
                    if (owner) {
                        supervisor.track(owner, name, () => instance.disconnect(), { instance });
                    }
                    return instance;
                },
            });
            this.assignPatch(this.root, name, Patched, name);
        }
    }

    patchPersistentResources() {
        const definitions = [
            ['Worker', 'worker', (instance) => instance.terminate()],
            ['SharedWorker', 'shared-worker', (instance) => instance.port?.close()],
            ['WebSocket', 'websocket', (instance) => instance.close()],
            ['EventSource', 'event-source', (instance) => instance.close()],
        ];
        for (const [name, kind, close] of definitions) {
            const Original = this.root[name];
            if (typeof Original !== 'function') continue;
            const supervisor = this;
            let Patched;
            Patched = new Proxy(Original, {
                construct(target, args, newTarget) {
                    const owner = supervisor.resolveOwner();
                    const actualNewTarget = newTarget === Patched ? target : newTarget;
                    const instance = Reflect.construct(target, args, actualNewTarget);
                    if (owner) supervisor.track(owner, kind, () => close(instance), { instance });
                    return instance;
                },
            });
            this.assignPatch(this.root, name, Patched, name);
        }
    }

    patchEventBus(eventBus) {
        if (!eventBus || typeof eventBus !== 'object' || this.patchedEventBuses.has(eventBus)) return;
        const originalOn = typeof eventBus.on === 'function' ? eventBus.on : null;
        const originalOnce = typeof eventBus.once === 'function' ? eventBus.once : null;
        const originalRemove = typeof eventBus.removeListener === 'function'
            ? eventBus.removeListener
            : typeof eventBus.off === 'function' ? eventBus.off : null;
        if (!originalOn || !originalRemove) return;
        const supervisor = this;

        const makeRegister = (original, kind) => function (eventName, listener, ...args) {
            if (supervisor.eventBusCaptureDepth > 0) {
                return Reflect.apply(original, this, [eventName, listener, ...args]);
            }
            const owner = supervisor.resolveOwner();
            supervisor.eventBusCaptureDepth++;
            let result;
            try {
                result = supervisor.withoutNestedTracking(() => Reflect.apply(original, this, [eventName, listener, ...args]));
            } finally {
                supervisor.eventBusCaptureDepth--;
            }
            if (owner && typeof listener === 'function') {
                supervisor.track(owner, kind, () => Reflect.apply(originalRemove, eventBus, [eventName, listener]), {
                    eventBus,
                    eventName,
                    listener,
                });
            }
            return result;
        };

        this.assignPatch(eventBus, 'on', makeRegister(originalOn, 'st-event'), 'eventSource.on');
        if (originalOnce) {
            this.assignPatch(eventBus, 'once', makeRegister(originalOnce, 'st-event-once'), 'eventSource.once');
        }
        const removeListener = function (eventName, listener, ...args) {
            const result = Reflect.apply(originalRemove, this, [eventName, listener, ...args]);
            supervisor.deactivateWhere((resource) => (resource.kind === 'st-event' || resource.kind === 'st-event-once')
                && resource.meta.eventBus === this
                && resource.meta.eventName === eventName
                && resource.meta.listener === listener);
            return result;
        };
        if (typeof eventBus.removeListener === 'function') {
            this.assignPatch(eventBus, 'removeListener', removeListener, 'eventSource.removeListener');
        }
        if (typeof eventBus.off === 'function') {
            this.assignPatch(eventBus, 'off', removeListener, 'eventSource.off');
        }
        this.patchedEventBuses.add(eventBus);
    }

    getJQueryBindings(args) {
        const events = args[0];
        const selector = typeof args[1] === 'string' ? args[1] : undefined;
        if (events && typeof events === 'object' && !Array.isArray(events)) {
            return Object.entries(events)
                .filter(([, handler]) => typeof handler === 'function' || handler === false)
                .map(([eventName, handler]) => ({ events: eventName, selector, handler }));
        }
        const handler = [...args].reverse().find((value) => typeof value === 'function' || value === false);
        return typeof events === 'string' && handler !== undefined ? [{ events, selector, handler }] : [];
    }

    patchJQuery() {
        const jquery = this.root.jQuery;
        const prototype = jquery?.fn;
        if (!prototype?.on || !prototype?.off) return;
        const supervisor = this;
        const originalOn = prototype.on;
        const originalOne = prototype.one;
        const originalOff = prototype.off;

        const makeRegister = (original, kind) => function (...args) {
            const owner = supervisor.resolveOwner();
            const bindings = owner ? supervisor.getJQueryBindings(args) : [];
            const elements = bindings.length > 0 && typeof this.toArray === 'function' ? this.toArray() : [];
            const result = supervisor.withoutNestedTracking(() => Reflect.apply(original, this, args));
            for (const binding of bindings) {
                supervisor.track(owner, kind, () => {
                    const collection = jquery(elements);
                    if (binding.selector !== undefined) {
                        Reflect.apply(originalOff, collection, [binding.events, binding.selector, binding.handler]);
                    } else {
                        Reflect.apply(originalOff, collection, [binding.events, binding.handler]);
                    }
                }, { elements, ...binding });
            }
            return result;
        };

        this.assignPatch(prototype, 'on', makeRegister(originalOn, 'jquery-event'), 'jQuery.on');
        if (typeof originalOne === 'function') {
            this.assignPatch(prototype, 'one', makeRegister(originalOne, 'jquery-event-once'), 'jQuery.one');
        }
    }

    nodesFromInsertion(node) {
        if (!node) return [];
        if (this.root.DocumentFragment && node instanceof this.root.DocumentFragment) {
            return [...node.childNodes];
        }
        return [node];
    }

    trackInsertedNodes(owner, candidates, wasConnected) {
        for (const node of candidates) {
            if (!node || wasConnected.get(node) || !node.isConnected) {
                if (wasConnected.get(node)) {
                    this.markOpaque(owner, 'moved-existing-dom');
                    this.markOpaque(this.nodeOwners.get(node), 'owned-dom-moved');
                }
                continue;
            }
            if (this.nodeOwners.has(node)) continue;
            this.nodeOwners.set(node, owner);
            this.track(owner, 'dom-node', () => {
                if (node.isConnected) node.remove();
            }, { node });
        }
    }

    patchDomInsertion() {
        const NodePrototype = this.root.Node?.prototype;
        if (!NodePrototype) return;
        const supervisor = this;

        const patchNodeMethod = (name, nodeIndex) => {
            const original = NodePrototype[name];
            if (typeof original !== 'function') return;
            function insertionMethod(...args) {
                const owner = supervisor.resolveOwner();
                const candidates = owner ? supervisor.nodesFromInsertion(args[nodeIndex]) : [];
                const wasConnected = new Map(candidates.map((node) => [node, Boolean(node.isConnected)]));
                if (owner && name === 'replaceChild') supervisor.markOpaque(owner, 'replaced-existing-dom');
                const result = Reflect.apply(original, this, args);
                if (owner) supervisor.trackInsertedNodes(owner, candidates, wasConnected);
                return result;
            }
            supervisor.assignPatch(NodePrototype, name, insertionMethod, `Node.${name}`);
        };

        patchNodeMethod('appendChild', 0);
        patchNodeMethod('insertBefore', 0);
        patchNodeMethod('replaceChild', 0);

        const ElementPrototype = this.root.Element?.prototype;
        if (!ElementPrototype) return;
        for (const name of ['append', 'prepend']) {
            const original = ElementPrototype[name];
            if (typeof original !== 'function') continue;
            function insertionMethod(...args) {
                const owner = supervisor.resolveOwner();
                const candidates = owner ? args.filter((item) => item instanceof supervisor.root.Node) : [];
                if (owner && candidates.length !== args.length) supervisor.markOpaque(owner, 'untracked-dom-text-insertion');
                const wasConnected = new Map(candidates.map((node) => [node, Boolean(node.isConnected)]));
                const result = Reflect.apply(original, this, args);
                if (owner) supervisor.trackInsertedNodes(owner, candidates, wasConnected);
                return result;
            }
            this.assignPatch(ElementPrototype, name, insertionMethod, `Element.${name}`);
        }
    }
}

/**
 * Install or reuse the page-wide runtime supervisor singleton.
 * @param {{eventSource?: object, selfUrl?: string}} options
 * @returns {RuntimeSupervisor}
 */
export function getRuntimeSupervisor(options = {}) {
    const root = globalThis;
    const selfOwner = extensionOwnerFromUrl(options.selfUrl ?? import.meta.url);
    let supervisor = root[SUPERVISOR_SYMBOL];
    if (!supervisor) {
        supervisor = new RuntimeSupervisor(root, selfOwner);
        Object.defineProperty(root, SUPERVISOR_SYMBOL, {
            configurable: false,
            enumerable: false,
            writable: false,
            value: supervisor,
        });
    }
    return supervisor.install(options.eventSource);
}

/**
 * Create an isolated supervisor for tests or embedded runtimes.
 * @param {object} root
 * @param {{eventSource?: object, selfUrl?: string}} options
 * @returns {RuntimeSupervisor}
 */
export function createRuntimeSupervisor(root, options = {}) {
    const selfOwner = extensionOwnerFromUrl(options.selfUrl ?? '');
    return new RuntimeSupervisor(root, selfOwner).install(options.eventSource);
}
