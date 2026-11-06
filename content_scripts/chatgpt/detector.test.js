import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
const machineSource = fs.readFileSync(new URL("./completion-machine.js", import.meta.url), "utf8");
const detectorSource = fs.readFileSync(new URL("./detector.js", import.meta.url), "utf8");
const version = JSON.parse(fs.readFileSync(new URL("../../manifest.json", import.meta.url), "utf8")).version;
const controlsSandbox = {};
vm.runInNewContext(detectorSource, controlsSandbox);
const read = doc => controlsSandbox.ChatGPTPageControls.read(doc, node => node.style);

function matches(node, selector) {
    if (!node || node.nodeType !== 1) return false;
    const trimmed = String(selector).trim();
    if (trimmed.indexOf(",") !== -1) {
        const parts = trimmed.split(",");
        for (let i = 0; i < parts.length; i += 1) {
            if (matches(node, parts[i])) return true;
        }
        return false;
    }
    if (/^[a-zA-Z][\w-]*$/.test(trimmed)) return node.tagName === trimmed.toUpperCase();
    const tagged = trimmed.match(/^([a-zA-Z][\w-]*)(\[.*\])$/);
    if (tagged) return node.tagName === tagged[1].toUpperCase() && matches(node, tagged[2]);
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return false;
    const body = trimmed.slice(1, -1);
    const eq = body.indexOf("=");
    if (eq === -1) return node.getAttribute(body) != null;
    let name = body.slice(0, eq);
    let op = "";
    if (name.endsWith("^") || name.endsWith("$")) {
        op = name.slice(-1);
        name = name.slice(0, -1);
    }
    let expected = body.slice(eq + 1);
    if ((expected.startsWith("'") && expected.endsWith("'")) || (expected.startsWith('"') && expected.endsWith('"'))) {
        expected = expected.slice(1, -1);
    }
    const actual = node.getAttribute(name);
    if (actual == null) return false;
    if (op === "^") return String(actual).startsWith(expected);
    if (op === "$") return String(actual).endsWith(expected);
    return actual === expected;
}

function walk(node, visit) {
    const children = node.children || [];
    for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (child.nodeType !== 1) continue;
        visit(child);
        walk(child, visit);
    }
}

function el(tag, attrs, children) {
    const node = {
        nodeType: 1,
        tagName: String(tag).toUpperCase(),
        attrs: attrs || {},
        children: children || [],
        parentElement: null,
        isConnected: true,
        rects: 1,
        style: { display: "block", visibility: "visible" },
        getClientRects() { return this.isConnected && this.rects ? [{}] : []; },
    };
    node.getAttribute = function (name) {
        return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null;
    };
    node.matches = function (selector) {
        return matches(node, selector);
    };
    node.closest = function (selector) {
        let current = node;
        while (current && current.nodeType === 1) {
            if (current.matches(selector)) return current;
            current = current.parentElement;
        }
        return null;
    };
    node.contains = function (other) {
        let current = other;
        while (current) {
            if (current === node) return true;
            current = current.parentElement;
        }
        return false;
    };
    node.querySelectorAll = function (selector) {
        const found = [];
        walk(node, function (candidate) {
            if (candidate.matches(selector)) found.push(candidate);
        });
        return found;
    };
    node.querySelector = function (selector) {
        return node.querySelectorAll(selector)[0] || null;
    };
    for (let i = 0; i < node.children.length; i += 1) {
        node.children[i].parentElement = node;
    }
    return node;
}

function documentFrom(children) {
    const doc = el("#document", {}, children);
    doc.nodeType = 9;
    doc.querySelector = function (selector) {
        return doc.querySelectorAll(selector)[0] || null;
    };
    doc.querySelectorAll = function (selector) {
        const found = [];
        walk(doc, function (candidate) {
            if (candidate.matches(selector)) found.push(candidate);
        });
        return found;
    };
    doc.getElementById = function (id) {
        let found = null;
        walk(doc, function (candidate) {
            if (!found && candidate.getAttribute("id") === id) found = candidate;
        });
        return found;
    };
    return doc;
}


function button(label, attrs = {}) { return el('button', { 'aria-label': label, ...attrs }); }
function harness(initial = []) {
    const body = el('body', {}, initial), html = el('html', {}, [body]);
    const doc = documentFrom([html]); doc.documentElement = html; doc.hidden = false;
    const timers = new Map(), observers = [], messages = [], logs = [], errors = [];
    let clock = 0, serial = 0;
    const sandbox = {
        document: doc, crypto: { randomUUID: () => 'doc-fixture' },
        location: { href: 'https://chatgpt.com/c/PRIVATE_ID?token=PRIVATE_QUERY' },
        getComputedStyle: node => node.style,
        console: { log: (...args) => logs.push(args), error: (...args) => errors.push(args) },
        chrome: { runtime: {
            getManifest: () => ({ version }),
            sendMessage: async payload => { messages.push(payload); return { ok: true, tabId: 17 }; },
        } },
        MutationObserver: class {
            constructor(fn) { this.fn = fn; observers.push(this); }
            observe(target, options) { this.target = target; this.options = options; }
        },
        setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, at: clock + ms }); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    vm.createContext(sandbox); vm.runInContext(machineSource, sandbox); vm.runInContext(detectorSource, sandbox);
    return {
        body, doc, sandbox, observers, messages, logs, errors,
        sounds: () => messages.filter(m => m.action === 'play_sound'),
        mutate() { observers.forEach(observer => observer.fn([])); },
        show(children) {
            body.children.forEach(child => { child.isConnected = false; child.parentElement = null; });
            body.children = children; children.forEach(child => { child.parentElement = body; });
            this.mutate();
        },
        advance(ms) {
            const end = clock + ms;
            while (true) {
                const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]); clock = due[1].at; due[1].fn();
            }
            clock = end;
        },
    };
}
test('verified Chinese and English controls work without inputs, transcript selectors or ids', () => {
    for (const stop of ['停止', '停止生成', 'Stop generating', 'Stop streaming']) {
        assert.equal(read(documentFrom([button(stop)])).state, 'ACTIVE');
    }
    for (const ready of [button('发送'), button('Send message'), button('开始语音'), el('a', { 'aria-label': '开启语音' })]) {
        assert.equal(read(documentFrom([ready])).state, 'READY');
    }
    assert.equal(read(documentFrom([el('button', { 'data-testid': 'stop-button' })])).state, 'ACTIVE');
    assert.equal(read(documentFrom([el('button', { 'data-testid': 'composer-speech-button' })])).state, 'READY');
    assert.equal(read(documentFrom([button('开始听写')])).state, 'UNKNOWN');
});
test('visible stop outranks all idle controls, including an old connected composer', () => {
    assert.equal(read(documentFrom([button('发送'), button('开始语音'), button('停止')])).state, 'ACTIVE');
    assert.equal(read(documentFrom([button('停止'), button('发送')])).state, 'ACTIVE');
});
test('hidden, inert, aria-hidden and CSS-hidden old controls are excluded', () => {
    for (const attrs of [{ hidden: '' }, { 'aria-hidden': 'true' }, { inert: '' }]) {
        assert.equal(read(documentFrom([el('div', attrs, [button('停止')]), button('发送')])).state, 'READY');
    }
    for (const kind of ['rects', 'visibility', 'display', 'disconnected']) {
        const stop = button('停止');
        if (kind === 'rects') stop.rects = 0;
        if (kind === 'visibility') stop.style.visibility = 'hidden';
        if (kind === 'display') stop.style.display = 'none';
        if (kind === 'disconnected') stop.isConnected = false;
        assert.equal(read(documentFrom([stop, button('发送')])).state, 'READY');
    }
});
test('disabled and aria-disabled empty send controls are positive idle evidence', () => {
    assert.equal(read(documentFrom([button('发送消息', { 'aria-disabled': 'true' })])).state, 'READY');
    assert.equal(read(documentFrom([button('Send', { disabled: '' })])).state, 'READY');
    assert.equal(read(documentFrom([el('button', { type: 'submit' })])).state, 'UNKNOWN');
});
test('document observer follows two responses in replaced layouts and emits once each', async () => {
    const h = harness([button('发送')]);
    assert.equal(h.observers.length, 1); assert.equal(h.observers[0].target, h.doc.documentElement);
    h.advance(5000); assert.equal(h.sounds().length, 0);
    for (const sequence of [1, 2]) {
        h.show([el('div', {}, [button('停止')])]); h.advance(60000); assert.equal(h.sounds().length, sequence - 1);
        h.show([el('form', {}, [button('开始语音')])]); h.advance(800);
        assert.equal(h.sounds().length, sequence); assert.equal(h.sounds().at(-1).sequence, sequence);
        h.mutate(); h.advance(5000); assert.equal(h.sounds().length, sequence);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.errors, []);
    assert.ok(h.logs.some(row => row[1] === 'PLAY_SOUND_ACK'));
});
test('delayed old content, including an old connected hidden panel, cannot arm a response', () => {
    const h = harness([button('发送')]);
    const historic = el('div', {}, []);
    Object.defineProperty(historic, 'textContent', { get() { throw new Error('Do not read conversation content'); } });
    h.show([historic, button('开始语音')]); h.advance(30000); assert.equal(h.sounds().length, 0);
    h.show([el('div', { hidden: '' }, [button('停止')]), button('发送')]); h.advance(10000);
    assert.equal(h.sounds().length, 0);
});
test('new chat with retained old DOM and arbitrary URL changes cannot reset live detection', () => {
    const h = harness([button('发送')]);
    const old = el('div', { 'aria-hidden': 'true' }, [button('发送')]);
    h.show([old, el('div', {}, [button('停止')])]);
    for (const path of ['/', '/c/provisional', '/c/canonical', '/g/example/c/other']) {
        h.sandbox.location.href = 'https://chatgpt.com' + path;
        h.mutate(); h.advance(1000);
    }
    assert.equal(h.sounds().length, 0);
    h.show([old, button('发送消息')]); h.advance(800); assert.equal(h.sounds().length, 1);
});
test('unknown remount and brief control jitter hold the same generation', () => {
    const h = harness([button('停止')]); h.show([]); h.advance(5000); assert.equal(h.sounds().length, 0);
    h.show([button('发送')]); h.advance(700); h.show([button('停止')]); h.advance(5000);
    assert.equal(h.sounds().length, 0);
    h.show([button('开始语音')]); h.advance(800); assert.equal(h.sounds().length, 1);
});
test('background tab remains observable and delayed settling re-reads the live DOM', () => {
    const h = harness([button('停止')]); h.doc.hidden = true;
    h.show([button('发送')]);
    // Change live UI without delivering the mutation callback before the timer.
    h.body.children = [button('停止')]; h.body.children[0].parentElement = h.body;
    h.advance(60000); assert.equal(h.sounds().length, 0);
    h.show([button('发送')]); h.advance(800); assert.equal(h.sounds().length, 1);
});
test('switching to idle or explicitly stopping follows the accepted page-level completion rule', () => {
    const h = harness([button('停止')]); h.sandbox.location.href = 'https://chatgpt.com/c/another';
    h.show([button('发送')]); h.advance(800); assert.equal(h.sounds().length, 1);
});
test('multiple tabs finish together without a global cooldown', () => {
    const a = harness([button('停止')]), b = harness([button('停止')]);
    a.show([button('发送')]); b.show([button('发送')]); a.advance(800); b.advance(800);
    assert.equal(a.sounds().length, 1); assert.equal(b.sounds().length, 1);
});
test('diagnostics never include URL, prompt or response and do not log every mutation', () => {
    const h = harness([button('停止')]); const before = h.logs.length;
    for (let i = 0; i < 100; i++) h.mutate();
    assert.equal(h.logs.length, before);
    assert.ok(!JSON.stringify(h.logs).includes('PRIVATE_'));
    assert.ok(h.logs.some(row => row[1] === 'CONTENT_SCRIPT_LOADED' && JSON.parse(row[2]).version === version));
});

test('failed playback is explicit and cannot stick the next page generation', async () => {
    const h = harness([button('停止')]);
    let attempts = 0;
    h.sandbox.chrome.runtime.sendMessage = async () => { attempts++; return { ok: false }; };
    h.show([button('发送')]); h.advance(800);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 1); assert.ok(h.errors.some(row => row[1] === 'PLAY_SOUND_FAILED'));
    h.mutate(); h.advance(10000); assert.equal(attempts, 1);
    h.show([button('停止')]); h.show([button('发送')]); h.advance(800);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 2);
});
