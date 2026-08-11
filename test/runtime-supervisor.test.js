import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createRuntimeSupervisor,
    extensionOwnerFromStack,
    extensionOwnerFromUrl,
} from '../lib/runtime-supervisor.js';

test('extracts third-party extension owners from module URLs and stacks', () => {
    assert.equal(
        extensionOwnerFromUrl('http://localhost/scripts/extensions/third-party/Demo/index.js?v=1'),
        'third-party/Demo',
    );
    assert.equal(extensionOwnerFromStack(`Error\n at start (http://localhost/scripts/extensions/third-party/Demo/index.js:4:2)`), 'third-party/Demo');
    assert.equal(extensionOwnerFromStack(`Error\n at self (http://localhost/scripts/extensions/third-party/Self/index.js:1:1)`, 'third-party/Self'), '');
});

test('tracks and disposes reversible listeners, timers, fetches, and event bus handlers', async () => {
    class TestEventTarget extends EventTarget {}
    const listeners = new Map();
    const eventBus = {
        on(eventName, listener) {
            listeners.set(eventName, listener);
        },
        once(eventName, listener) {
            listeners.set(eventName, listener);
        },
        removeListener(eventName, listener) {
            if (listeners.get(eventName) === listener) listeners.delete(eventName);
        },
    };
    const runtime = {
        EventTarget: TestEventTarget,
        AbortController,
        AbortSignal,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
    };
    let pendingFetchSignal;
    runtime.fetch = (_input, init) => {
        pendingFetchSignal = init.signal;
        return new Promise(() => {});
    };
    const supervisor = createRuntimeSupervisor(runtime, { eventSource: eventBus });
    const target = new TestEventTarget();
    let calls = 0;
    const listener = () => calls++;

    supervisor.runWithOwner('third-party/Demo', () => {
        target.addEventListener('demo', listener);
        runtime.setInterval(() => calls++, 60_000);
        eventBus.on('chat-changed', listener);
        void runtime.fetch('/pending');
    });

    const snapshot = supervisor.getSnapshot('third-party/Demo');
    assert.equal(snapshot.eligible, true);
    assert.deepEqual(snapshot.counts, {
        'dom-listener': 1,
        fetch: 1,
        interval: 1,
        'st-event': 1,
    });

    target.dispatchEvent(new Event('demo'));
    assert.equal(calls, 1);
    assert.equal(listeners.has('chat-changed'), true);
    assert.equal(pendingFetchSignal.aborted, false);

    const disposal = await supervisor.dispose('third-party/Demo');
    assert.equal(disposal.complete, true);
    assert.equal(disposal.cleaned, 4);
    assert.equal(listeners.has('chat-changed'), false);
    assert.equal(pendingFetchSignal.aborted, true);
    target.dispatchEvent(new Event('demo'));
    assert.equal(calls, 1);
});
