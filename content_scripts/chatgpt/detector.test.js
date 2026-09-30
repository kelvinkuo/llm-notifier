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
