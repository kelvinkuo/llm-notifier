import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';

// A small DOM fixture exposing only the semantics captured from the live page.
function harness() {
    const listeners = {}, windowListeners = {}, timers = new Map(), messages = [];
    let clock = 0, next = 0, onMutation;
    const state = { stop: false, draft: false, input: true, responses: [] };
    const element = (label, extra = {}) => ({
        isConnected: true, disabled: false,
        getClientRects: () => [{}],
        closest(selector) { return selector === 'button' && label ? this : null; },
        matches(selector) {
            return selector === `button[aria-label="${label}"]`
                || (label === 'input' && selector.includes('[role="textbox"]'));
        },
        ...extra,
    });
    const stop = element('Stop response'), send = element('Send message'), dictate = element('Dictate'), input = element('input');
    function response(busy = false, ready = true) {
        const content = { contains: node => node === content, getAttribute: name => name === 'aria-busy' ? String(busy) : null };
        const actions = element(null, { querySelector: selector => selector === '[data-test-id="thumb-up-button"]' && r.ready ? {} : null });
        const r = { busy, ready, failed: false,
            querySelector(selector) {
                if (selector === 'message-content [aria-busy]') return { getAttribute: () => String(r.busy) };
                if (selector === 'message-content') return content;
                if (selector === 'message-actions') return r.ready ? actions : null;
                if (selector === '[role="alert"]') return r.failed ? {} : null;
                throw new Error(`Unexpected selector: ${selector}`);
            }, content,
        };
        return r;
    }
    const sandbox = {
        crypto: { randomUUID: () => 'fixture-session' }, location: { pathname: '/app/test' },
        chrome: { runtime: { sendMessage: async message => { messages.push(message); } } },
        setTimeout(fn, ms) { const id = ++next; timers.set(id, { at: clock + ms, fn }); return id; },
        clearTimeout(id) { timers.delete(id); },
        MutationObserver: class { constructor(fn) { onMutation = fn; } observe() {} },
        window: { addEventListener(name, fn) { windowListeners[name] = fn; } },
        document: {
            documentElement: {}, addEventListener(name, fn) { listeners[name] = fn; },
            querySelectorAll(selector) {
                if (selector === 'model-response') return state.responses;
                if (selector.includes('Stop response')) return state.stop ? [stop] : [];
                if (selector.includes('Send message')) return state.draft ? [send] : [];
                if (selector.includes('Dictate')) return [dictate];
                if (selector.includes('[role="textbox"]')) return state.input ? [input] : [];
                throw new Error(`Unexpected selector: ${selector}`);
            },
        },
    };
    state.responses.push(response());
    vm.createContext(sandbox);
    for (const file of ['completion-machine.js', 'detector.js']) {
        vm.runInContext(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), sandbox);
    }
    return {
        state, messages, sandbox,
        mutate(mutations = []) { onMutation(mutations); },
        advance(ms) {
            const end = clock + ms;
            while (true) {
                const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                clock = due[1].at; timers.delete(due[0]); due[1].fn();
            }
            clock = end;
        },
        start(keyboard = false) {
            state.draft = true;
            if (keyboard) listeners.keydown({ key: 'Enter', target: input });
            else listeners.click({ target: send });
            state.draft = false; state.stop = true;
            state.responses.push(response(true, false)); onMutation([]);
        },
        finish() { state.stop = false; const r = state.responses.at(-1); r.busy = false; r.ready = true; onMutation([]); },
        stop(keyboard = false) {
            if (keyboard) listeners.keydown({ key: ' ', target: stop });
            else listeners.pointerdown({ target: stop });
        },
        navigate(path) { sandbox.location.pathname = path; onMutation([]); },
        popstate() { windowListeners.popstate(); },
    };
}
test('actual DOM selectors bridge button/keyboard turns to one content message each', () => {
    const h = harness(); h.mutate(); h.advance(5000); assert.equal(h.messages.length, 0);
    h.start(); h.advance(10000); assert.equal(h.messages.length, 0);
    h.finish(); h.advance(1050); assert.equal(h.messages.length, 1);
    h.start(true); h.finish(); h.advance(1050); assert.equal(h.messages.length, 2);
    assert.equal(h.messages[1].sequence, 2); assert.equal(h.messages[1].provider, 'Gemini');
    assert.deepEqual(Object.keys(h.messages[0]).sort(), ['action', 'provider', 'sequence', 'session']);
});
test('a sub-50ms active phase is captured and input replacement does not lose the turn', () => {
    const h = harness(); h.start(); h.finish(); h.state.input = false; h.mutate(); h.advance(3000);
    assert.equal(h.messages.length, 0); h.state.input = true; h.mutate(); h.advance(1050);
    assert.equal(h.messages.length, 1);
});
test('mouse and keyboard stop suppress even a subsequently visible normal footer', () => {
    for (const keyboard of [true, false]) {
        const h = harness(); h.start(); h.stop(keyboard); h.finish(); h.advance(5000);
        assert.equal(h.messages.length, 0);
    }
});
test('route switch and browser history invalidate pending completion', () => {
    for (const action of [h => h.navigate('/app/history'), h => h.popstate()]) {
        const h = harness(); h.start(); h.finish(); h.advance(50); action(h); h.advance(5000);
        assert.equal(h.messages.length, 0);
    }
});
test('content mutations reset settling and error response does not complete', () => {
    const h = harness(); h.start(); h.finish(); h.advance(900);
    h.mutate([{ type: 'characterData', target: h.state.responses.at(-1).content }]); h.advance(900);
    assert.equal(h.messages.length, 0); h.advance(200); assert.equal(h.messages.length, 1);
    h.start(); h.state.responses.at(-1).failed = true; h.finish(); h.advance(5000);
    assert.equal(h.messages.length, 1);
});
