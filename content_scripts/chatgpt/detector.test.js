import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const machineSource = fs.readFileSync(new URL("./completion-machine.js", import.meta.url), "utf8");
const detectorSource = fs.readFileSync(new URL("./detector.js", import.meta.url), "utf8");
const sandbox = {
    URL,
    console,
    setTimeout,
    clearTimeout,
    WeakMap,
    Set,
};
vm.createContext(sandbox);
vm.runInContext(machineSource, sandbox);
vm.runInContext(detectorSource, sandbox);

const adapter = sandbox.ChatGPTMessageAdapter;
const { createChatGPTCompletionController } = sandbox.ChatGPTCompletion;

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

function currentUserTurn() {
    const bubble = el("div", { "data-user-message-bubble": "true" });
    return el("div", {
        "data-content-search-unit-key": "fallback-turn-10:0:user",
        "data-chatgpt-search-unit-key": "fallback-turn-10:0:user",
        "data-chatgpt-search-message-ids": "7f74eb45-6273-4d04-b862-f91650fe384e extra-id",
    }, [bubble]);
}

function currentAssistantTurn() {
    const markdown = el("div", { "data-markdown-text-style": "assistant-message" });
    const unit = el("div", {
        "data-content-search-unit-key": "fallback-turn-12:2:assistant",
        "data-chatgpt-search-unit-key": "fallback-turn-12:2:assistant",
        "data-chatgpt-selection-message-id": "be4acf82-9949-4792-ac09-b5ea2ed991a0",
    }, [markdown]);
    return el("div", {
        "data-turn-key": "79a60d84-0fcb-4f5e-872c-af2521a60e7b",
    }, [unit]);
}

function createHarness() {
    let now = 0;
    let nextId = 1;
    const timers = [];
    const notifications = [];
    const trace = [];
    const controller = createChatGPTCompletionController({
        settleMs: 800,
        now: function () { return now; },
        schedule: function (fn, ms) {
            const id = nextId;
            nextId += 1;
            timers.push({ id: id, fn: fn, at: now + ms });
            return id;
        },
        cancel: function (id) {
            const index = timers.findIndex(function (timer) { return timer.id === id; });
            if (index >= 0) timers.splice(index, 1);
        },
        onCompleted: function (event) {
            notifications.push(event);
        },
        onDebug: function (event, meta) {
            trace.push({ event: event, meta: meta || {} });
        },
    });
    return {
        controller: controller,
        notifications: notifications,
        trace: trace,
        advance: function (ms) {
            now += ms;
            while (timers.length > 0) {
                let nextIndex = 0;
                for (let i = 1; i < timers.length; i += 1) {
                    if (timers[i].at < timers[nextIndex].at) nextIndex = i;
                }
                if (timers[nextIndex].at > now) break;
                const timer = timers.splice(nextIndex, 1)[0];
                timer.fn();
            }
        },
    };
}

test("current user DOM is one user message", function () {
    const root = el("main", {}, [currentUserTurn()]);
    const users = adapter.findUserMessages(root);
    assert.equal(users.length, 1);
    assert.equal(users[0].getAttribute("data-content-search-unit-key"), "fallback-turn-10:0:user");
    assert.equal(
        JSON.stringify(adapter.messageIds(users)),
        JSON.stringify(["7f74eb45-6273-4d04-b862-f91650fe384e extra-id"]),
    );
});

test("current assistant DOM is one assistant message", function () {
    const root = el("main", {}, [currentAssistantTurn()]);
    const assistants = adapter.findAssistantMessages(root);
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].getAttribute("data-content-search-unit-key"), "fallback-turn-12:2:assistant");
    assert.equal(
        JSON.stringify(adapter.messageIds(assistants)),
        JSON.stringify(["be4acf82-9949-4792-ac09-b5ea2ed991a0"]),
    );
});

test("duplicate semantic selectors collapse to one assistant", function () {
    const turn = currentAssistantTurn();
    const root = el("div", { "data-thread-find-target": "conversation" }, [turn]);
    const assistants = adapter.findAssistantMessages(root);
    const markdown = turn.querySelector("[data-markdown-text-style='assistant-message']");
    const byContentKey = root.querySelector("[data-content-search-unit-key$=':assistant']");
    const bySearchKey = root.querySelector("[data-chatgpt-search-unit-key$=':assistant']");
    assert.ok(markdown);
    assert.ok(byContentKey);
    assert.ok(bySearchKey);
    assert.equal(assistants.length, 1);
    assert.equal(adapter.messageIds(assistants).length, 1);
    assert.equal(assistants[0], byContentKey);
});

test("short answer with one assistant insertion notifies once", function () {
    const harness = createHarness();
    const root = el("div", { "data-thread-find-target": "conversation" }, [
        currentUserTurn(),
        currentAssistantTurn(),
    ]);
    harness.controller.noteBaseline({
        userMessageIds: [],
        assistantMessageIds: [],
        rootSelector: "[data-thread-find-target='conversation']",
        rootTag: "DIV",
        composerFound: true,
    });
    harness.controller.noteDom({
        userMessageIds: adapter.messageIds(adapter.findUserMessages(root)),
        assistantMessageIds: adapter.messageIds(adapter.findAssistantMessages(root)),
        assistantChanged: false,
        stopControl: false,
        composerState: "idle",
        continueOffered: false,
        activityBlocked: false,
        rootSelector: "[data-thread-find-target='conversation']",
    });
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].messageId, "be4acf82-9949-4792-ac09-b5ea2ed991a0");
    assert.equal(harness.notifications[0].reason, "GENERATION_SETTLED");
    assert.equal(harness.trace.filter(function (entry) { return entry.event === "GENERATION_SIGNAL" && entry.meta.signal === "assistant_created"; }).length, 1);
});

test("response failure keeps the active sequence and still notifies", function () {
    const harness = createHarness();
    const user = currentUserTurn();
    const assistant = currentAssistantTurn();
    const root = el("div", { "data-thread-find-target": "conversation" }, [user]);
    harness.controller.noteBaseline({
        userMessageIds: [],
        assistantMessageIds: [],
        rootSelector: "[data-thread-find-target='conversation']",
    });
    harness.controller.noteDom({
        userMessageIds: adapter.messageIds(adapter.findUserMessages(root)),
        assistantMessageIds: [],
        stopControl: false,
    });
    assert.equal(harness.controller.getState().activeSequence, 1);
    harness.controller.noteNetwork("RESPONSE_REQUEST_STARTED");
    harness.controller.noteNetwork("FINALIZE_SEEN");
    root.children.push(assistant);
    assistant.parentElement = root;
    harness.controller.noteDom({
        userMessageIds: adapter.messageIds(adapter.findUserMessages(root)),
        assistantMessageIds: adapter.messageIds(adapter.findAssistantMessages(root)),
        assistantChanged: false,
        stopControl: false,
    });
    harness.controller.noteNetwork("RESPONSE_FAILED");
    assert.equal(harness.controller.getState().activeSequence, 1);
    harness.controller.noteNetwork("PREPARE_SEEN");
    assert.equal(harness.controller.getState().activeSequence, 1);
    const failure = harness.trace.filter(function (entry) { return entry.event === "RESPONSE_FAILED"; });
    assert.equal(failure.length, 1);
    assert.equal(failure[0].meta.sequence, 1);
    assert.equal(failure[0].meta.networkFailedSeen, true);
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].sequence, 1);
});

test("history already on screen does not notify", function () {
    const harness = createHarness();
    const root = el("main", {}, [currentUserTurn(), currentAssistantTurn()]);
    const userMessageIds = adapter.messageIds(adapter.findUserMessages(root));
    const assistantMessageIds = adapter.messageIds(adapter.findAssistantMessages(root));
    harness.controller.noteBaseline({
        userMessageIds: userMessageIds,
        assistantMessageIds: assistantMessageIds,
        rootSelector: "main",
        rootTag: "MAIN",
        composerFound: false,
    });
    harness.controller.noteDom({
        userMessageIds: userMessageIds,
        assistantMessageIds: assistantMessageIds,
        assistantChanged: true,
        stopControl: false,
    });
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
});

test("conversation root is preferred and contenteditable is the composer fallback", function () {
    const conversation = el("div", { "data-thread-find-target": "conversation" });
    const main = el("main", {}, [conversation]);
    const editor = el("div", { contenteditable: "true" });
    const doc = documentFrom([main, editor]);
    const found = adapter.findConversationRoot(doc);
    assert.equal(found.element, conversation);
    assert.equal(found.selector, "[data-thread-find-target='conversation']");
    assert.equal(adapter.findComposer(doc, main), editor);
});

function composerDoc(controls, formAttrs) {
    const prompt = el("div", { id: "prompt-textarea", contenteditable: "true" });
    const form = el("form", formAttrs || {}, [prompt].concat(controls));
    return documentFrom([form]);
}

test("composer semantic state comes from verified labels, not button type", function () {
    const reader = sandbox.ChatGPTComposer;
    const stop = el("button", { "data-testid": "stop-button", "aria-label": "Stop streaming" });
    const send = el("button", { "data-testid": "send-button", "aria-label": "Send prompt", disabled: "" });
    const speech = el("button", { "data-testid": "composer-speech-button", "aria-label": "开始语音" });
    assert.equal(reader.readState(composerDoc([stop, send]), null), "ACTIVE");
    assert.equal(reader.readState(composerDoc([send]), null), "READY_DRAFT");
    assert.equal(reader.readState(composerDoc([speech]), null), "READY_EMPTY");
    assert.equal(reader.readState(composerDoc([]), null), "UNKNOWN");
    assert.equal(reader.readState(documentFrom([]), null), "UNKNOWN");
    assert.equal(reader.readState(composerDoc([send], { "aria-busy": "true" }), null), "READY_DRAFT");
    const labeledStop = el("button", { "aria-label": "停止生成" });
    assert.equal(reader.readState(composerDoc([labeledStop]), null), "ACTIVE");
    const unverifiedVoice = el("button", { type: "button", "aria-label": "Start dictation" });
    assert.equal(reader.readState(composerDoc([unverifiedVoice]), null), "UNKNOWN");
});

test("real composer controls distinguish empty, draft, active, and unknown", function () {
    const reader = sandbox.ChatGPTComposerAdapter;
    const chineseStop = el("button", { type: "button", "aria-label": "停止" });
    const chineseSend = el("button", { type: "submit", "aria-label": "发送" });
    const chineseVoice = el("button", { type: "button", "aria-label": "开始语音" });
    const englishStop = el("button", { type: "button", "aria-label": "Stop" });
    const englishSend = el("button", { type: "submit", "aria-label": "Send" });
    const bareSubmit = el("button", { type: "submit" });
    const bareButton = el("button", { type: "button" });
    const unrelated = el("button", { type: "button", "aria-label": "Attach" });
    assert.equal(reader.getComposerState(composerDoc([chineseStop])), "ACTIVE");
    assert.equal(reader.getComposerState(composerDoc([englishStop])), "ACTIVE");
    assert.equal(reader.getComposerState(composerDoc([el("button", { type: "button", "aria-label": "Stop streaming" })])), "ACTIVE");
    assert.equal(reader.getComposerState(composerDoc([chineseSend])), "READY_DRAFT");
    assert.equal(reader.getComposerState(composerDoc([englishSend])), "READY_DRAFT");
    assert.equal(reader.getComposerState(composerDoc([chineseVoice])), "READY_EMPTY");
    assert.equal(reader.getComposerState(composerDoc([bareSubmit])), "UNKNOWN");
    assert.equal(reader.getComposerState(composerDoc([bareButton])), "UNKNOWN");
    assert.equal(reader.getComposerState(composerDoc([unrelated])), "UNKNOWN");
    assert.equal(reader.getComposerState(composerDoc([])), "UNKNOWN");

    const voiceObservation = reader.readComposer(composerDoc([chineseVoice]));
    assert.equal(voiceObservation.state, "READY_EMPTY");
    assert.equal(voiceObservation.primaryLabel, "开始语音");
    assert.equal(voiceObservation.primaryType, "button");
    const sendObservation = reader.readComposer(composerDoc([chineseSend]));
    assert.equal(sendObservation.state, "READY_DRAFT");
    assert.equal(sendObservation.primaryLabel, "发送");
    assert.equal(sendObservation.primaryType, "submit");
    const stopObservation = reader.readComposer(composerDoc([chineseStop]));
    assert.equal(stopObservation.state, "ACTIVE");
    assert.equal(stopObservation.primaryLabel, "停止");
    assert.equal(stopObservation.primaryType, "button");

    const straySend = el("button", { type: "submit", "aria-label": "发送" });
    assert.equal(reader.getComposerState(documentFrom([straySend])), "UNKNOWN");

    const stop = el("button", { type: "button", "aria-label": "停止" });
    const footer = el("div", { "data-composer-footer-responsive": "true" }, [stop]);
    const editable = el("div", { contenteditable: "true" });
    const body = el("div", { "data-composer-body": "true" }, [editable]);
    const layout = el("div", { "data-composer-layout": "true" }, [body, footer]);
    const doc = documentFrom([layout]);
    assert.equal(reader.findComposerRoot(doc), layout);
    assert.equal(reader.getComposerState(doc), "ACTIVE");

    footer.children[0] = el("button", { type: "button", "aria-label": "开始语音" });
    footer.children[0].parentElement = footer;
    assert.equal(reader.getComposerState(doc), "READY_EMPTY");
});

test("duplicate search message ids collapse to one identity", function () {
    const node = el("div", { "data-chatgpt-search-message-ids": "abc abc" });
    assert.equal(adapter.messageIdentity(node), "abc");
    const spaced = el("div", { "data-chatgpt-search-message-ids": "abc   abc" });
    assert.equal(adapter.messageIdentity(spaced), "abc");
    const distinct = el("div", { "data-chatgpt-search-message-ids": "abc def" });
    assert.equal(adapter.messageIdentity(distinct), "abc def");
});

test("2026 anonymous transcript uses role-bearing li ids and presence-only user bubbles", function () {
    const bubble = el("div", { "data-user-message-bubble": "" });
    const user = el("li", { "data-message-role": "user", id: "anonymous-user-1" }, [bubble]);
    const nested = el("div", { "data-markdown-text-style": "assistant-message" });
    const assistant = el("li", { "data-message-role": "assistant", id: "anonymous-assistant-1" }, [nested]);
    const root = el("main", { "data-slot": "conversation" }, [user, assistant]);
    assert.equal(adapter.findUserMessages(root).length, 1);
    assert.equal(adapter.findUserMessages(root)[0], user);
    assert.equal(adapter.findAssistantMessages(root).length, 1);
    assert.equal(adapter.findAssistantMessages(root)[0], assistant);
    assert.equal(adapter.messageIdentity(assistant), "anonymous-assistant-1");
    assert.equal(adapter.messageIdentity(user), "anonymous-user-1");
    assert.equal(adapter.findUserMessages(el("main", {}, [bubble])).length, 1);
    assert.equal(adapter.isAssistantPending(assistant), true);
    assistant.attrs["data-message-complete"] = "";
    assert.equal(adapter.isAssistantPending(assistant), false);
    assert.equal(adapter.isAssistantPending(currentAssistantTurn()), false);
});

function anonymousComposer(controls, draft = "") {
    const textarea = el("textarea", { id: "mobile-composer-prompt", "data-mobile-composer-prompt": "", name: "prompt" });
    textarea.value = draft;
    const form = el("form", {}, [el("div", { "data-composer-editor-host": "" }, [textarea]), ...controls]);
    return { textarea, form, doc: documentFrom([el("div", { "data-composer-layout": "" }, [form])]) };
}

test("anonymous textarea recognizes empty send, draft and stop; hidden stale controls are ignored", function () {
    const send = el("button", { "aria-label": "发送消息", type: "submit", "aria-disabled": "true" });
    const stop = el("button", { "aria-label": "停止生成", type: "button" });
    const empty = anonymousComposer([send]);
    const reader = sandbox.ChatGPTComposerAdapter;
    assert.equal(adapter.findComposer(empty.doc), empty.form);
    assert.equal(reader.getComposerState(empty.doc), "READY_EMPTY");
    empty.textarea.value = "test";
    send.attrs['aria-disabled'] = 'false';
    assert.equal(reader.getComposerState(empty.doc), "READY_DRAFT");
    assert.equal(reader.getComposerState(anonymousComposer([stop, send]).doc), "ACTIVE");
    assert.equal(reader.getComposerState(anonymousComposer([el("div", { hidden: "" }, [stop]), send]).doc), "READY_EMPTY");
});

test("anonymous message completion blocks quiet streaming until explicit terminal marker", function () {
    const h = createHarness();
    const user = el("li", { "data-message-role": "user", id: "u1" });
    const assistant = el("li", { "data-message-role": "assistant", id: "a1" });
    const root = el("main", {}, [user, assistant]);
    h.controller.noteBaseline({ userMessageIds: [], assistantMessageIds: [] });
    const view = () => ({
        userMessageIds: adapter.messageIds(adapter.findUserMessages(root)),
        assistantMessageIds: adapter.messageIds(adapter.findAssistantMessages(root)),
        composerState: "READY_EMPTY",
        activityBlocked: adapter.isAssistantPending(assistant),
    });
    h.controller.noteDom(view()); h.advance(10000);
    assert.equal(h.notifications.length, 0);
    assistant.attrs['data-message-complete'] = '';
    h.controller.noteDom(view()); h.advance(800);
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].messageId, 'a1');
    h.controller.noteDom(view()); h.advance(5000);
    assert.equal(h.notifications.length, 1);
});

// Boot the complete content script, not just the selector adapter. Keep the
// composer outside <main>, as it is on the inspected anonymous page.
function anonymousDetector(initialHistory = false) {
    const editor = el('textarea', { id: 'mobile-composer-prompt' }); editor.value = '';
    const control = el('button', { 'aria-label': '发送消息', 'aria-disabled': 'true', type: 'submit' });
    const form = el('form', {}, [editor, control]);
    const layout = el('div', { 'data-composer-layout': '' }, [form]);
    const main = el('main', { 'data-slot': 'conversation' });
    const body = el('body', {}, [main, layout]);
    const html = el('html', {}, [body]);
    const doc = documentFrom([html]); doc.documentElement = html;
    const listeners = {}, observers = [], sent = [], errors = [], diagnosticLogs = [], runtimeListeners = [], timers = new Map();
    let time = 0, serial = 0;
    doc.addEventListener = (name, fn) => { listeners[name] = fn; };
    function append(node) { main.children.push(node); node.parentElement = main; }
    function message(role, id, complete) {
        const node = el('li', { 'data-message-role': role, id });
        node.textContent = ''; node.childElementCount = 0;
        if (complete) node.attrs['data-message-complete'] = '';
        return node;
    }
    if (initialHistory) { append(message('user', 'history-u')); append(message('assistant', 'history-a', true)); }
    const location = { hostname: 'chatgpt.com', pathname: '/', href: 'https://chatgpt.com/?token=private-test-value' };
    const environment = {
        URL, location, document: doc, WeakMap, Set,
        Element: class { static [Symbol.hasInstance](value) { return value?.nodeType === 1; } },
        console: { log(...args) { diagnosticLogs.push(args); }, error(...args) { errors.push(args); } },
        window: { addEventListener() {} },
        chrome: { runtime: { sendMessage(payload) { sent.push(payload); return Promise.resolve(); }, onMessage: { addListener(fn) { runtimeListeners.push(fn); } } } },
        MutationObserver: class {
            constructor(fn) { this.fn = fn; observers.push(this); }
            observe(target, options) { this.target = target; this.options = options; }
            disconnect() { this.target = null; }
        },
        setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, at: time + ms }); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    vm.createContext(environment); vm.runInContext(machineSource, environment); vm.runInContext(detectorSource, environment);
    const sounds = () => sent.filter(p => p.action === 'play_sound');
    return {
        sounds, errors, diagnosticLogs, main, append, message, editor, control, observers, location,
        receiveRuntime(message) { runtimeListeners.forEach(fn => fn(message)); },
        submit() { editor.value = 'test'; listeners.keydown({ key: 'Enter', target: editor }); editor.value = ''; },
        mutate(target, type = 'childList', attributeName) {
            const mutation = { target, type, attributeName, addedNodes: type === 'childList' ? target.children : [], removedNodes: [] };
            for (const observer of [...observers]) {
                if (!observer.target || !(observer.target === target || (observer.options.subtree && observer.target.contains(target)))) continue;
                if (type === 'attributes' && (!observer.options.attributes || !observer.options.attributeFilter.includes(attributeName))) continue;
                observer.fn([mutation]);
            }
        },
        advance(ms) {
            const end = time + ms;
            while (true) {
                const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]); time = due[1].at; due[1].fn();
            }
            time = end;
        },
    };
}

test('full anonymous detector: outside composer, /uc promotion, completion-only attribute update, two rounds', function () {
    const h = anonymousDetector(); h.advance(50); assert.deepEqual(h.errors, []);
    assert.equal(h.sounds().length, 0);
    for (const sequence of [1, 2]) {
        h.submit();
        h.control.attrs['aria-label'] = '停止生成';
        h.append(h.message('user', `u${sequence}`));
        const assistant = h.message('assistant', `a${sequence}`); h.append(assistant);
        h.mutate(h.main); h.mutate(h.control, 'attributes', 'aria-label'); h.advance(50);
        if (sequence === 1) {
            h.location.pathname = '/uc/anonymous'; h.location.href = 'https://chatgpt.com/uc/anonymous';
            h.mutate(h.main); h.advance(50);
        }
        h.advance(10000); assert.equal(h.sounds().length, sequence - 1);
        // The composer may become idle before the last terminal attribute update.
        h.control.attrs['aria-label'] = '发送消息';
        h.mutate(h.control, 'attributes', 'aria-label'); h.advance(5000);
        assert.equal(h.sounds().length, sequence - 1);
        assistant.attrs['data-message-complete'] = '';
        h.mutate(assistant, 'attributes', 'data-message-complete'); h.advance(850);
        assert.equal(h.sounds().length, sequence);
        assert.equal(h.sounds().at(-1).messageId, `a${sequence}`);
        h.mutate(assistant); h.advance(5000); assert.equal(h.sounds().length, sequence);
    }
    assert.deepEqual(h.errors, []);
});

test('full anonymous detector ignores history on load and supports independent tabs', function () {
    const history = anonymousDetector(true); history.advance(10000); assert.equal(history.sounds().length, 0);
    const tabs = [anonymousDetector(), anonymousDetector()];
    for (const h of tabs) {
        h.advance(50); h.submit(); h.control.attrs['aria-label'] = '停止生成';
        h.append(h.message('user', 'u1')); h.append(h.message('assistant', 'a1'));
        h.mutate(h.main); h.mutate(h.control, 'attributes', 'aria-label'); h.advance(50);
    }
    for (const h of tabs) {
        h.main.children.at(-1).attrs['data-message-complete'] = '';
        h.control.attrs['aria-label'] = '发送消息';
        h.mutate(h.main.children.at(-1), 'attributes', 'data-message-complete');
        h.mutate(h.control, 'attributes', 'aria-label'); h.advance(850);
    }
    assert.deepEqual(tabs.map(h => h.sounds().length), [1, 1]);
});

test('anonymous pending assistant replacement keeps the live answer and only notifies once', function () {
    const h = anonymousDetector(); h.advance(50);
    h.submit();
    h.control.attrs['aria-label'] = '停止生成';
    h.append(h.message('user', 'u1')); const pending = h.message('assistant', 'pending-a1'); h.append(pending);
    h.mutate(h.main); h.mutate(h.control, 'attributes', 'aria-label'); h.advance(50);
    const final = h.message('assistant', 'final-a1');
    pending.isConnected = false; pending.parentElement = null;
    h.main.children[h.main.children.length - 1] = final; final.parentElement = h.main;
    h.mutate(h.main); h.advance(5000); assert.equal(h.sounds().length, 0);
    final.attrs['data-message-complete'] = ''; h.control.attrs['aria-label'] = '发送消息';
    h.mutate(final, 'attributes', 'data-message-complete'); h.mutate(h.control, 'attributes', 'aria-label'); h.advance(850);
    assert.equal(h.sounds().length, 1); assert.equal(h.sounds()[0].messageId, 'final-a1');
});

test('diagnostics expose loading and state transitions without URL query or per-chunk logs', function () {
    const h = anonymousDetector(); h.advance(50);
    const events = () => h.diagnosticLogs.map(args => args[1]);
    assert.ok(events().includes('CONTENT_SCRIPT_LOADED'));
    assert.ok(events().includes('ROOT_FOUND'));
    h.submit();
    h.control.attrs['aria-label'] = '停止生成';
    h.append(h.message('user', 'u1')); const assistant = h.message('assistant', 'a1'); h.append(assistant);
    h.mutate(h.main); h.mutate(h.control, 'attributes', 'aria-label'); h.advance(50);
    assert.ok(events().includes('USER_TURN_STARTED'));
    assert.ok(events().includes('GENERATION_STARTED'));
    for (let i = 0; i < 5; i++) {
        assistant.textContent = 'PRIVATE_PROMPT_OR_ANSWER_' + i;
        h.mutate(assistant, 'characterData'); h.advance(50);
    }
    assistant.attrs['data-message-complete'] = ''; h.control.attrs['aria-label'] = '发送消息';
    h.mutate(assistant, 'attributes', 'data-message-complete'); h.mutate(h.control, 'attributes', 'aria-label'); h.advance(850);
    for (const event of ['COMPOSER_STATE_CHANGED', 'GENERATION_ENDED', 'COMPLETION_CONFIRMED', 'PLAY_SOUND_SENT']) {
        assert.ok(events().includes(event), event);
    }
    const output = JSON.stringify(h.diagnosticLogs);
    assert.ok(!output.includes('private-test-value'));
    assert.ok(!output.includes('PRIVATE_PROMPT_OR_ANSWER'));
    assert.ok(!output.includes('assistant_mutation'));
    assert.ok(h.diagnosticLogs.every(args => args[0] === '[LLM Notifier][ChatGPT]'));
    assert.equal(h.sounds().length, 1);
    assert.ok(h.sounds()[0].diagnosticId.startsWith('doc-'));
});

test('route diagnostics identify delayed worker routes with stable aliases and no real URLs', function () {
    const h = anonymousDetector(); h.advance(50);
    h.location.pathname = '/c/PRIVATE_LIVE_ID';
    h.location.href = 'https://chatgpt.com/c/PRIVATE_LIVE_ID?token=PRIVATE_QUERY';
    h.receiveRuntime({ type: 'CHATGPT_ROUTE_CHANGED', url: 'https://chatgpt.com/c/PRIVATE_REPORTED_ID?secret=PRIVATE_SECRET' });
    const observed = h.diagnosticLogs.filter(row => row[1] === 'ROUTE_OBSERVED').map(row => JSON.parse(row[2]));
    const worker = observed.find(meta => meta.source === 'worker-history-message');
    assert.equal(worker.matchesLive, false);
    assert.notEqual(worker.reportedRoute, worker.liveRoute);
    const routeChange = h.diagnosticLogs.filter(row => row[1] === 'route changed').map(row => JSON.parse(row[2])).at(-1);
    assert.equal(routeChange.source, 'worker-history-message');
    assert.equal(routeChange.matchesLive, false);
    assert.equal(routeChange.toRoute, worker.reportedRoute);
    assert.equal(routeChange.liveRoute, worker.liveRoute);
    h.advance(50);
    const liveSnapshot = h.diagnosticLogs.filter(row => row[1] === 'ROUTE_OBSERVED').map(row => JSON.parse(row[2])).at(-1);
    assert.equal(liveSnapshot.source, 'pathname-snapshot');
    assert.equal(liveSnapshot.matchesLive, true);
    assert.equal(liveSnapshot.reportedRoute, worker.liveRoute);
    const output = JSON.stringify(h.diagnosticLogs);
    for (const secret of ['PRIVATE_LIVE_ID', 'PRIVATE_REPORTED_ID', 'PRIVATE_QUERY', 'PRIVATE_SECRET']) assert.ok(!output.includes(secret));
    assert.equal(h.sounds().length, 0);
});

test('delayed startup history never becomes a completion, even after later content rendering', function () {
    const h = anonymousDetector(); h.advance(50);
    h.advance(30000);
    h.append(h.message('user', 'loaded-history-u'));
    const assistant = h.message('assistant', 'loaded-history-a', true); h.append(assistant);
    h.mutate(h.main); h.advance(5000);
    assistant.textContent = 'history finished rendering'; h.mutate(assistant, 'characterData'); h.advance(5000);
    assert.equal(h.sounds().length, 0);
    assert.ok(h.diagnosticLogs.some(row => row[1] === 'HISTORY_BASELINE_UPDATED'));
    assert.ok(!h.diagnosticLogs.some(row => row[1] === 'USER_TURN_STARTED'));
});

test('upgraded root hydrating old history stays quiet, then the first real submission notifies', function () {
    const h = anonymousDetector(); h.advance(50);
    const conversation = el('div', { 'data-thread-find-target': 'conversation' });
    h.append(conversation); h.mutate(h.main); h.advance(50);
    function add(node) { conversation.children.push(node); node.parentElement = conversation; }
    add(h.message('user', 'historic-u')); add(h.message('assistant', 'historic-a', true));
    h.mutate(conversation); h.advance(5000); assert.equal(h.sounds().length, 0);
    h.submit(); h.control.attrs['aria-label'] = '停止生成';
    add(h.message('user', 'live-u')); const assistant = h.message('assistant', 'live-a'); add(assistant);
    h.mutate(conversation); h.mutate(h.control, 'attributes', 'aria-label'); h.advance(5000);
    assert.equal(h.sounds().length, 0);
    assistant.attrs['data-message-complete'] = ''; h.control.attrs['aria-label'] = '发送消息';
    h.mutate(assistant, 'attributes', 'data-message-complete'); h.mutate(h.control, 'attributes', 'aria-label'); h.advance(850);
    assert.equal(h.sounds().length, 1); assert.equal(h.sounds()[0].sequence, 1); assert.equal(h.sounds()[0].messageId, 'live-a');
});

test('startup generation stays quiet; a subsequent network-confirmed send can still notify', function () {
    const h = anonymousDetector(); h.advance(50);
    h.control.attrs['aria-label'] = '停止生成';
    h.append(h.message('user', 'startup-u')); const startup = h.message('assistant', 'startup-a'); h.append(startup);
    h.mutate(h.main); h.mutate(h.control, 'attributes', 'aria-label'); h.advance(5000);
    startup.attrs['data-message-complete'] = ''; h.control.attrs['aria-label'] = '发送消息';
    h.mutate(startup, 'attributes', 'data-message-complete'); h.mutate(h.control, 'attributes', 'aria-label'); h.advance(5000);
    assert.equal(h.sounds().length, 0);
    h.receiveRuntime({ type: 'CHATGPT_NETWORK_HINT', hint: 'RESPONSE_REQUEST_STARTED' });
    h.control.attrs['aria-label'] = '停止生成';
    h.append(h.message('user', 'live-u')); const live = h.message('assistant', 'live-a'); h.append(live);
    h.mutate(h.main); h.mutate(h.control, 'attributes', 'aria-label'); h.advance(50);
    live.attrs['data-message-complete'] = ''; h.control.attrs['aria-label'] = '发送消息';
    h.mutate(live, 'attributes', 'data-message-complete'); h.mutate(h.control, 'attributes', 'aria-label'); h.advance(850);
    assert.equal(h.sounds().length, 1); assert.equal(h.sounds()[0].messageId, 'live-a');
});
