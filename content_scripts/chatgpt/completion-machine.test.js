import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = fs.readFileSync(new URL('./completion-machine.js', import.meta.url), 'utf8');
function harness() {
    const sandbox = {}; vm.runInNewContext(source, sandbox);
    let time = 0, serial = 0, view = { state: 'UNKNOWN' };
    const timers = new Map(), events = [], diagnostics = [];
    const controller = sandbox.ChatGPTCompletion.createController({
        read: () => view, onCompleted: event => events.push(event.sequence),
        onDebug: (event, meta) => diagnostics.push({ event, ...meta }),
        schedule(fn, ms) { const id = ++serial; timers.set(id, { fn, at: time + ms }); return id; },
        cancel(id) { timers.delete(id); },
    });
    return {
        controller, events, diagnostics,
        observe(state) { view = { state }; controller.observe(view); },
        silent(state) { view = { state }; },
        advance(ms) {
            const end = time + ms;
            while (true) {
                const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                timers.delete(next[0]); time = next[1].at; next[1].fn();
            }
            time = end;
        },
    };
}
test('historical idle content never sounds; an observed active-ready cycle sounds exactly once', () => {
    const h = harness(); h.observe('READY'); h.advance(100000); assert.deepEqual(h.events, []);
    h.observe('ACTIVE'); h.observe('READY'); h.advance(799); assert.deepEqual(h.events, []);
    h.advance(1); h.observe('READY'); h.advance(100000); assert.deepEqual(h.events, [1]);
});
test('successive cycles each sound, without sharing turn failure state', () => {
    const h = harness();
    for (let i = 0; i < 3; i++) { h.observe('ACTIVE'); h.observe('READY'); h.advance(800); }
    assert.deepEqual(h.events, [1, 2, 3]);
});
test('Thinking, tools, and long streaming pauses stay silent while stop remains', () => {
    const h = harness(); h.observe('ACTIVE');
    for (let i = 0; i < 10; i++) { h.observe('ACTIVE'); h.advance(60000); }
    assert.deepEqual(h.events, []);
    assert.equal(h.diagnostics.filter(e => e.event === 'GENERATION_STARTED').length, 1);
    h.observe('READY'); h.advance(800); assert.deepEqual(h.events, [1]);
});
test('brief idle jitter returning to active cancels settling without splitting the cycle', () => {
    const h = harness(); h.observe('ACTIVE'); h.observe('READY'); h.advance(700);
    h.observe('ACTIVE'); h.advance(5000); assert.deepEqual(h.events, []);
    h.observe('READY'); h.advance(800); assert.deepEqual(h.events, [1]);
});
test('missing controls and remounts are unknown, never completion evidence', () => {
    const h = harness(); h.observe('ACTIVE'); h.observe('UNKNOWN'); h.advance(100000);
    assert.deepEqual(h.events, []);
    h.observe('READY'); h.advance(700); h.observe('UNKNOWN'); h.advance(5000);
    assert.deepEqual(h.events, []);
    h.observe('READY'); h.advance(800); assert.deepEqual(h.events, [1]);
});
test('background timer checks live controls, not the cached ready observation', () => {
    for (const state of ['ACTIVE', 'UNKNOWN']) {
        const h = harness(); h.observe('ACTIVE'); h.observe('READY'); h.silent(state); h.advance(60000);
        assert.deepEqual(h.events, []);
        h.observe('READY'); h.advance(800); assert.deepEqual(h.events, [1]);
    }
});
test('starting on an already-generating page follows that observed generation', () => {
    const h = harness(); h.observe('ACTIVE'); h.observe('READY'); h.advance(800);
    assert.deepEqual(h.events, [1]);
});
test('multiple tabs have independent cycles, including simultaneous completion', () => {
    const a = harness(), b = harness(); a.observe('ACTIVE'); b.observe('ACTIVE');
    a.observe('READY'); a.advance(800); assert.deepEqual(a.events, [1]); assert.deepEqual(b.events, []);
    a.observe('ACTIVE'); a.observe('READY'); b.observe('READY'); a.advance(800); b.advance(800);
    assert.deepEqual(a.events, [1, 2]); assert.deepEqual(b.events, [1]);
});
test('disposed timers cannot play a stale notification', () => {
    const h = harness(); h.observe('ACTIVE'); h.observe('READY'); h.controller.dispose(); h.advance(5000);
    assert.deepEqual(h.events, []);
});
test('a failed live DOM read holds the cycle until a known idle signal returns', () => {
    const sandbox = {}; vm.runInNewContext(source, sandbox);
    let callback, sounds = 0;
    const controller = sandbox.ChatGPTCompletion.createController({
        read() { throw new Error('DOM unavailable'); }, onCompleted() { sounds++; },
        schedule(fn) { callback = fn; return 1; }, cancel() {},
    });
    controller.observe({ state: 'ACTIVE' }); controller.observe({ state: 'READY' }); callback();
    assert.equal(sounds, 0); assert.equal(controller.getState().phase, 'GENERATING');
});
