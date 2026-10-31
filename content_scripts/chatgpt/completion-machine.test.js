import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./completion-machine.js", import.meta.url), "utf8");
const sandbox = {
    URL,
    console,
    setTimeout,
    clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const { createChatGPTCompletionController } = sandbox.ChatGPTCompletion;

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function dom(partial) {
    return {
        generating: false,
        assistantPresent: false,
        assistantMessageId: null,
        assistantChanged: false,
        continueOffered: false,
        activityBlocked: false,
        ...partial,
    };
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

function startTurn(controller, id) {
    controller.noteUserTurnStarted({ source: "send" });
    controller.noteDom(dom({
        generating: true,
        assistantPresent: true,
        assistantMessageId: id,
        assistantChanged: true,
    }));
    controller.noteDom(dom({
        generating: true,
        assistantPresent: true,
        assistantMessageId: id,
        assistantChanged: true,
    }));
}

test("historical messages do not notify", function () {
    const harness = createHarness();
    harness.controller.noteDom(dom({
        assistantPresent: true,
        assistantMessageId: "history-1",
        assistantChanged: true,
    }));
    harness.controller.noteDom(dom({
        assistantPresent: true,
        assistantMessageId: "history-2",
        assistantChanged: true,
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
});

test("a real turn notifies once after generation settles", function () {
    const harness = createHarness();
    startTurn(harness.controller, "assistant-1");
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
    }));
    harness.advance(799);
    assert.deepEqual(plain(harness.notifications), []);
    harness.advance(1);
    assert.deepEqual(plain(harness.notifications), [
        { sequence: 1, messageId: "assistant-1", reason: "GENERATION_SETTLED" },
    ]);
    harness.advance(5000);
    assert.equal(harness.notifications.length, 1);
});

test("thinking ending early does not notify before the answer settles", function () {
    const harness = createHarness();
    startTurn(harness.controller, "assistant-1");
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
    }));
    harness.advance(400);
    harness.controller.noteDom(dom({
        generating: true,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].reason, "GENERATION_SETTLED");
});

test("tool activity between segments notifies only after the answer settles", function () {
    const harness = createHarness();
    startTurn(harness.controller, "assistant-1");
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
        activityBlocked: true,
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
    harness.controller.noteDom(dom({
        generating: true,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
    }));
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
        activityBlocked: false,
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
});

test("conversation stream end while DOM is still generating does not notify", function () {
    const harness = createHarness();
    startTurn(harness.controller, "assistant-1");
    harness.controller.noteNetwork("RESPONSE_STREAM_ENDED");
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
});

test("finalize while the assistant DOM is still changing does not notify", function () {
    const harness = createHarness();
    startTurn(harness.controller, "assistant-1");
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
    }));
    harness.controller.noteNetwork("FINALIZE_SEEN");
    for (let i = 0; i < 4; i += 1) {
        harness.advance(500);
        harness.controller.noteDom(dom({
            generating: false,
            assistantPresent: true,
            assistantMessageId: "assistant-1",
            assistantChanged: true,
        }));
    }
    harness.advance(700);
    assert.deepEqual(harness.notifications, []);
});

test("stable DOM without a preceding generation does not notify", function () {
    const harness = createHarness();
    harness.controller.noteNetwork("RESPONSE_STREAM_ENDED");
    harness.controller.noteNetwork("PREPARE_SEEN");
    harness.controller.noteNetwork("FINALIZE_SEEN");
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: false,
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
});

test("a repeated completion for the same turn notifies once", function () {
    const harness = createHarness();
    startTurn(harness.controller, "assistant-1");
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
    }));
    harness.advance(800);
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
    }));
    harness.advance(5000);
    assert.equal(harness.notifications.length, 1);
});

test("route change followed by historical DOM does not notify", function () {
    const harness = createHarness();
    harness.controller.noteRouteChange("https://chatgpt.com/c/old");
    harness.controller.noteRouteChange("https://chatgpt.com/c/new");
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "history-9",
        assistantChanged: true,
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
});

test("regenerate notifies again for the new generation", function () {
    const harness = createHarness();
    startTurn(harness.controller, "assistant-1");
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: false,
    }));
    harness.advance(800);
    harness.controller.noteUserTurnStarted({ source: "regenerate" });
    harness.controller.noteDom(dom({
        generating: true,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
    }));
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
    }));
    harness.advance(800);
    assert.deepEqual(harness.notifications.map(function (event) { return event.sequence; }), [1, 2]);
    assert.equal(harness.notifications[1].reason, "GENERATION_SETTLED");
});

test("continue generating holds completion until the resumed answer settles", function () {
    const harness = createHarness();
    startTurn(harness.controller, "assistant-1");
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
        continueOffered: true,
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
    harness.controller.noteDom(dom({
        generating: true,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
    }));
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
        continueOffered: false,
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].sequence, 1);
});

test("user stop still completes after the DOM settles", function () {
    const harness = createHarness();
    startTurn(harness.controller, "assistant-1");
    harness.controller.noteUserStopped();
    harness.controller.noteNetwork("RESPONSE_FAILED");
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
    }));
    harness.advance(800);
    assert.deepEqual(plain(harness.notifications), [
        { sequence: 1, messageId: "assistant-1", reason: "USER_STOPPED" },
    ]);
});

test("network failure does not cancel an assistant turn that settles", function () {
    const harness = createHarness();
    startTurn(harness.controller, "assistant-1");
    assert.equal(harness.controller.getState().activeSequence, 1);
    harness.controller.noteNetwork("RESPONSE_FAILED");
    assert.equal(harness.controller.getState().activeSequence, 1);
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].messageId, "assistant-1");
    assert.equal(harness.notifications[0].sequence, 1);
});

test("a newly mounted historical assistant does not complete an armed turn", function () {
    const harness = createHarness();
    baseline(harness.controller, ["user-1"], ["assistant-old"]);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1", "user-new"],
        assistantMessageIds: ["assistant-old"],
        stopControl: false,
    }));
    assert.equal(harness.controller.getState().activeSequence, 1);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1", "user-new"],
        assistantMessageIds: ["assistant-history", "assistant-old"],
        assistantChanged: false,
        stopControl: false,
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
    assert.equal(harness.controller.getState().generationSeen, false);
});

test("startup generation and a later real turn", function () {
    const harness = createHarness();
    harness.controller.suppressIfAlreadyGenerating(true);
    harness.controller.noteDom(dom({
        generating: true,
        assistantPresent: true,
        assistantMessageId: "inflight",
        assistantChanged: true,
    }));
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "inflight",
        assistantChanged: true,
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);

    startTurn(harness.controller, "assistant-2");
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-2",
        assistantChanged: true,
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].messageId, "assistant-2");
});

test("assigning a conversation id during generation keeps the turn", function () {
    const harness = createHarness();
    harness.controller.noteRouteChange("https://chatgpt.com/");
    startTurn(harness.controller, "assistant-1");
    harness.controller.noteRouteChange("https://chatgpt.com/c/new-chat");
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "assistant-1",
        assistantChanged: true,
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
});

function baseline(controller, users, assistants) {
    controller.noteBaseline({
        userMessageIds: users,
        assistantMessageIds: assistants,
        rootTag: "MAIN",
        composerFound: true,
    });
}

test("short answer without a stop button notifies once", function () {
    const harness = createHarness();
    baseline(harness.controller, ["user-old"], ["assistant-old"]);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-old", "user-new"],
        assistantMessageIds: ["assistant-old"],
        stopControl: false,
        composerState: "idle",
    }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-old", "user-new"],
        assistantMessageIds: ["assistant-old", "assistant-short"],
        assistantChanged: true,
        stopControl: false,
        composerState: "idle",
    }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-old", "user-new"],
        assistantMessageIds: ["assistant-old", "assistant-short"],
        assistantChanged: false,
        stopControl: false,
        composerState: "idle",
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].messageId, "assistant-short");
    assert.equal(harness.notifications[0].reason, "GENERATION_SETTLED");
});

test("existing history at startup does not notify", function () {
    const harness = createHarness();
    baseline(harness.controller, ["user-1"], ["assistant-1"]);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-1"],
        assistantChanged: true,
        stopControl: false,
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
});

test("mutations after completion do not notify again", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-1"],
        assistantChanged: true,
        stopControl: false,
        composerState: "idle",
    }));
    harness.advance(800);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-1"],
        assistantChanged: true,
        stopControl: false,
        composerState: "idle",
    }));
    harness.advance(5000);
    assert.equal(harness.notifications.length, 1);
});

test("completion emits one play_sound message", function () {
    const messages = [];
    const harness = createHarness();
    harness.controller = sandbox.ChatGPTCompletion.createChatGPTCompletionController({
        settleMs: 800,
        now: function () { return 0; },
        schedule: function (fn) {
            messages.pending = fn;
            return 1;
        },
        cancel: function () {},
        onCompleted: function (event) {
            messages.push(sandbox.ChatGPTCompletion.createPlaySoundMessage(event));
        },
    });
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-1"],
        assistantChanged: false,
        stopControl: false,
        composerState: "idle",
    }));
    messages.pending();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].action, "play_sound");
    assert.equal(messages[0].provider, "ChatGPT");
    assert.equal(messages[0].sequence, 1);
    messages.pending();
    assert.equal(messages.length, 1);
});

test("root watcher attaches after main appears and rebinds when it is replaced", function () {
    const events = [];
    let main = null;
    let bootstrapCallback = null;
    let parentCallback = null;
    const watcher = sandbox.ChatGPTCompletion.createRootWatcher({
        queryRoot: function () { return main; },
        observeUntilRoot: function (onMutate) {
            bootstrapCallback = onMutate;
            return { disconnect: function () { bootstrapCallback = null; } };
        },
        observeParent: function (root, onMutate) {
            parentCallback = onMutate;
            events.push("parent:" + root.id);
            return { disconnect: function () { parentCallback = null; } };
        },
        onWaiting: function () { events.push("WAITING_FOR_ROOT"); },
        onReplaced: function () { events.push("ROOT_REPLACED"); },
        onFound: function (root, info) {
            events.push("ROOT_FOUND:" + root.id + ":" + info.replaced);
        },
    });

    watcher.start();
    assert.deepEqual(events, ["WAITING_FOR_ROOT"]);

    const first = { id: "main-1", isConnected: true };
    main = first;
    bootstrapCallback();
    assert.equal(bootstrapCallback, null);
    assert.deepEqual(events, [
        "WAITING_FOR_ROOT",
        "parent:main-1",
        "ROOT_FOUND:main-1:false",
    ]);

    first.isConnected = false;
    main = { id: "main-2", isConnected: true };
    parentCallback();
    assert.deepEqual(events, [
        "WAITING_FOR_ROOT",
        "parent:main-1",
        "ROOT_FOUND:main-1:false",
        "ROOT_REPLACED",
        "parent:main-2",
        "ROOT_FOUND:main-2:true",
    ]);
});

test("switching to an in-progress conversation does not notify", function () {
    const harness = createHarness();
    harness.controller.noteRouteChange("https://chatgpt.com/c/old");
    harness.controller.noteRouteChange("https://chatgpt.com/c/live");
    harness.controller.noteDom(dom({
        generating: true,
        assistantPresent: true,
        assistantMessageId: "live-1",
        assistantChanged: true,
    }));
    harness.controller.noteDom(dom({
        generating: false,
        assistantPresent: true,
        assistantMessageId: "live-1",
        assistantChanged: true,
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
});

function blockedReasons(harness) {
    return harness.trace.filter(function (entry) {
        return entry.event === "COMPLETION_BLOCKED";
    }).map(function (entry) {
        return entry.meta.reason;
    });
}

test("thinking pause after the final assistant appears does not notify while generation stays active", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: [],
        composerState: "active",
    }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-thinking"],
        assistantChanged: true,
        composerState: "active",
    }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-thinking"],
        assistantChanged: true,
        composerState: "active",
    }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-thinking", "assistant-final"],
        assistantChanged: true,
        composerState: "active",
    }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-thinking", "assistant-final"],
        assistantChanged: false,
        composerState: "active",
    }));
    harness.advance(1500);
    assert.deepEqual(harness.notifications, []);
    assert.ok(blockedReasons(harness).indexOf("generation_active") !== -1);
    assert.ok(harness.trace.some(function (entry) { return entry.event === "GENERATION_ACTIVE_ENTER"; }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-thinking", "assistant-final"],
        assistantChanged: true,
        composerState: "active",
    }));
    harness.advance(1500);
    assert.deepEqual(harness.notifications, []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-thinking", "assistant-final"],
        assistantChanged: false,
        composerState: "idle",
    }));
    harness.advance(799);
    assert.deepEqual(harness.notifications, []);
    harness.advance(1);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].messageId, "assistant-final");
    assert.equal(harness.notifications[0].reason, "GENERATION_SETTLED");
    assert.ok(harness.trace.some(function (entry) { return entry.event === "GENERATION_IDLE_ENTER"; }));
    harness.advance(5000);
    assert.equal(harness.notifications.length, 1);
});

test("an active composer outranks a long assistant settle", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-1"],
        assistantChanged: true,
        composerState: "active",
    }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-1"],
        assistantChanged: false,
        composerState: "active",
    }));
    harness.controller.noteNetwork("RESPONSE_STREAM_ENDED");
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
    assert.ok(blockedReasons(harness).indexOf("generation_active") !== -1);
    assert.equal(harness.trace.some(function (entry) { return entry.event === "GENERATION_IDLE_ENTER"; }), false);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-1"],
        assistantChanged: false,
        composerState: "idle",
    }));
    harness.advance(799);
    assert.deepEqual(harness.notifications, []);
    harness.advance(1);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].reason, "GENERATION_SETTLED");
});

test("unknown composer state does not settle until a response end hint", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: [],
        composerState: "unknown",
    }));
    harness.controller.noteNetwork("RESPONSE_REQUEST_STARTED");
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-1"],
        assistantChanged: true,
        composerState: "unknown",
    }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-1"],
        assistantChanged: false,
        composerState: "unknown",
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
    assert.ok(harness.trace.some(function (entry) { return entry.event === "COMPOSER_STATE_UNKNOWN"; }));
    assert.ok(blockedReasons(harness).indexOf("composer_unknown") !== -1);
    assert.equal(blockedReasons(harness).indexOf("generation_active"), -1);
    harness.controller.noteNetwork("RESPONSE_FAILED");
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
    harness.controller.noteNetwork("RESPONSE_STREAM_ENDED");
    harness.advance(799);
    assert.deepEqual(harness.notifications, []);
    harness.advance(1);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].messageId, "assistant-1");
    assert.equal(harness.notifications[0].reason, "GENERATION_SETTLED");
    assert.ok(harness.trace.some(function (entry) { return entry.event === "FALLBACK_COMPLETION_PATH"; }));
});

function turnDom(partial) {
    return dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-1"],
        ...partial,
    });
}

test("composer primary path notifies once after stop returns to send", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: [],
        composerState: "idle",
    }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: [],
        composerState: "active",
    }));
    harness.controller.noteDom(turnDom({
        assistantChanged: true,
        composerState: "active",
    }));
    harness.controller.noteDom(turnDom({
        assistantChanged: true,
        composerState: "active",
    }));
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        composerState: "active",
    }));
    harness.advance(2000);
    assert.deepEqual(harness.notifications, []);
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        composerState: "idle",
    }));
    harness.advance(799);
    assert.deepEqual(harness.notifications, []);
    harness.advance(1);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].messageId, "assistant-1");
    assert.equal(harness.notifications[0].reason, "GENERATION_SETTLED");
    assert.ok(harness.trace.some(function (entry) { return entry.event === "PRIMARY_COMPLETION_PATH"; }));
    assert.ok(harness.trace.some(function (entry) {
        return entry.event === "COMPOSER_TRANSITION" && entry.meta.transition === "ACTIVE -> READY_EMPTY";
    }));
    assert.equal(harness.trace.some(function (entry) { return entry.event === "FALLBACK_COMPLETION_PATH"; }), false);
});

test("thinking pause before the final answer does not notify while stop remains", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: [],
        composerState: "active",
    }));
    harness.controller.noteDom(turnDom({
        assistantMessageIds: ["assistant-thinking"],
        assistantChanged: true,
        composerState: "active",
    }));
    harness.controller.noteDom(turnDom({
        assistantMessageIds: ["assistant-thinking", "assistant-final"],
        assistantChanged: true,
        composerState: "active",
    }));
    harness.controller.noteDom(turnDom({
        assistantMessageIds: ["assistant-thinking", "assistant-final"],
        assistantChanged: false,
        composerState: "active",
    }));
    harness.advance(2000);
    assert.deepEqual(harness.notifications, []);
    assert.ok(blockedReasons(harness).indexOf("generation_active") !== -1);
    harness.controller.noteDom(turnDom({
        assistantMessageIds: ["assistant-thinking", "assistant-final"],
        assistantChanged: true,
        composerState: "active",
    }));
    harness.advance(1500);
    assert.deepEqual(harness.notifications, []);
    harness.controller.noteDom(turnDom({
        assistantMessageIds: ["assistant-thinking", "assistant-final"],
        assistantChanged: false,
        composerState: "idle",
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].messageId, "assistant-final");
    assert.ok(harness.trace.some(function (entry) { return entry.event === "PRIMARY_COMPLETION_PATH"; }));
});

test("tool pause does not notify while the composer stays active", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-tool"],
        assistantChanged: true,
        composerState: "active",
    }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-tool"],
        assistantChanged: false,
        composerState: "active",
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
    assert.ok(blockedReasons(harness).indexOf("generation_active") !== -1);
});

test("assistant silence for ten seconds does not complete while the composer is active", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(turnDom({
        assistantChanged: true,
        composerState: "active",
    }));
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        composerState: "active",
    }));
    harness.advance(10000);
    assert.deepEqual(harness.notifications, []);
    assert.equal(harness.trace.some(function (entry) { return entry.event === "PRIMARY_COMPLETION_PATH"; }), false);
    assert.equal(harness.trace.some(function (entry) { return entry.event === "FALLBACK_COMPLETION_PATH"; }), false);
});

test("unknown composer state is not idle while the network request stays open", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: [],
        composerState: "unknown",
    }));
    harness.controller.noteNetwork("RESPONSE_REQUEST_STARTED");
    harness.controller.noteDom(turnDom({
        assistantChanged: true,
        composerState: "unknown",
    }));
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        composerState: "unknown",
    }));
    harness.advance(800);
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
    assert.ok(blockedReasons(harness).indexOf("composer_unknown") !== -1);
    assert.equal(blockedReasons(harness).indexOf("generation_active"), -1);
});

test("short answer fallback notifies once when stop was never observed", function () {
    const harness = createHarness();
    baseline(harness.controller, ["user-old"], ["assistant-old"]);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-old", "user-new"],
        assistantMessageIds: ["assistant-old"],
        composerState: "unknown",
    }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-old", "user-new"],
        assistantMessageIds: ["assistant-old", "assistant-ok"],
        assistantChanged: true,
        composerState: "unknown",
    }));
    harness.controller.noteNetwork("RESPONSE_STREAM_ENDED");
    harness.controller.noteDom(dom({
        userMessageIds: ["user-old", "user-new"],
        assistantMessageIds: ["assistant-old", "assistant-ok"],
        assistantChanged: false,
        composerState: "unknown",
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].messageId, "assistant-ok");
    assert.equal(harness.notifications[0].reason, "GENERATION_SETTLED");
    assert.ok(harness.trace.some(function (entry) { return entry.event === "FALLBACK_COMPLETION_PATH"; }));
    assert.equal(harness.trace.some(function (entry) { return entry.event === "PRIMARY_COMPLETION_PATH"; }), false);
    assert.equal(harness.controller.getState().composerActiveSeen, false);
});

test("network finalize does not finish a turn that already saw composer active", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-1"],
        assistantChanged: true,
        composerState: "active",
    }));
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        composerState: "active",
    }));
    harness.controller.noteNetwork("FINALIZE_SEEN");
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
    assert.ok(blockedReasons(harness).indexOf("generation_active") !== -1);
    assert.equal(harness.trace.some(function (entry) { return entry.event === "FALLBACK_COMPLETION_PATH"; }), false);
});

test("regenerate waits for a fresh active to idle cycle", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-1"],
        assistantChanged: true,
        stopControl: true,
        composerState: "active",
    }));
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        stopControl: false,
        composerState: "idle",
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);

    harness.controller.noteUserTurnStarted({ source: "regenerate" });
    assert.equal(harness.controller.getState().composerActiveSeen, false);
    assert.equal(harness.controller.getState().networkFailedSeen, false);
    harness.controller.noteDom(turnDom({
        assistantChanged: true,
        stopControl: true,
        composerState: "active",
    }));
    harness.advance(5000);
    assert.equal(harness.notifications.length, 1);
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        stopControl: false,
        composerState: "idle",
    }));
    harness.advance(800);
    assert.deepEqual(harness.notifications.map(function (event) { return event.sequence; }), [1, 2]);
    assert.equal(harness.notifications[1].reason, "GENERATION_SETTLED");
    assert.equal(harness.trace.filter(function (entry) { return entry.event === "PRIMARY_COMPLETION_PATH"; }).length, 2);
});

test("networkFailedSeen stays true for later hints until the turn resets", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: [],
        composerState: "active",
    }));
    assert.equal(harness.controller.getState().networkFailedSeen, false);
    harness.controller.noteNetwork("RESPONSE_FAILED");
    assert.equal(harness.controller.getState().networkFailedSeen, true);
    harness.controller.noteNetwork("PREPARE_SEEN");
    assert.equal(harness.controller.getState().networkFailedSeen, true);
    const prepare = harness.trace.filter(function (entry) {
        return entry.event === "GENERATION_SIGNAL" && entry.meta.hint === "PREPARE_SEEN";
    });
    assert.equal(prepare.length, 1);
    assert.equal(prepare[0].meta.networkFailedSeen, true);
    harness.controller.noteNetwork("FINALIZE_SEEN");
    assert.equal(harness.controller.getState().networkFailedSeen, true);
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
    harness.controller.reset("turn finished");
    assert.equal(harness.controller.getState().networkFailedSeen, false);
});

test("stop returning to active during settle cancels completion", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(turnDom({
        assistantChanged: true,
        composerState: "active",
    }));
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        composerState: "idle",
    }));
    harness.advance(400);
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        composerState: "active",
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        composerState: "idle",
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].reason, "GENERATION_SETTLED");
});

test("user stop completes only after stop returns to send", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(turnDom({
        assistantChanged: true,
        composerState: "active",
    }));
    harness.controller.noteUserStopped();
    harness.advance(2000);
    assert.deepEqual(harness.notifications, []);
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        composerState: "idle",
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].reason, "USER_STOPPED");
    assert.ok(harness.trace.some(function (entry) { return entry.event === "PRIMARY_COMPLETION_PATH"; }));
});

function composerDom(state, partial) {
    return dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: ["assistant-1"],
        composerState: state,
        composerPrimaryLabel: partial && partial.composerPrimaryLabel,
        composerPrimaryType: partial && partial.composerPrimaryType,
        ...partial,
    });
}

test("empty composer becoming a draft does not notify", function () {
    const harness = createHarness();
    baseline(harness.controller, ["user-1"], ["assistant-1"]);
    harness.controller.noteDom(composerDom("READY_EMPTY", {
        assistantChanged: false,
        composerPrimaryLabel: "开始语音",
        composerPrimaryType: "button",
    }));
    harness.controller.noteDom(composerDom("READY_DRAFT", {
        assistantChanged: false,
        composerPrimaryLabel: "发送",
        composerPrimaryType: "submit",
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
    assert.equal(harness.trace.some(function (entry) { return entry.event === "TURN_ARMED"; }), false);
    assert.equal(harness.trace.some(function (entry) { return entry.event === "GENERATION_IDLE_ENTER"; }), false);
    assert.ok(harness.trace.some(function (entry) {
        return entry.event === "COMPOSER_STATE_READY_EMPTY"
            && entry.meta.state === "READY_EMPTY"
            && entry.meta.primaryLabel === "开始语音"
            && entry.meta.primaryType === "button";
    }));
    assert.ok(harness.trace.some(function (entry) {
        return entry.event === "COMPOSER_TRANSITION" && entry.meta.transition === "READY_EMPTY -> READY_DRAFT";
    }));
});

test("draft to active marks the turn as generation active", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: [],
        composerState: "READY_DRAFT",
        composerPrimaryLabel: "发送",
        composerPrimaryType: "submit",
    }));
    assert.equal(harness.controller.getState().composerActiveSeen, false);
    assert.ok(harness.trace.some(function (entry) { return entry.event === "TURN_ARMED"; }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: [],
        composerState: "ACTIVE",
        composerPrimaryLabel: "停止",
        composerPrimaryType: "button",
    }));
    assert.equal(harness.controller.getState().composerActiveSeen, true);
    assert.ok(harness.trace.some(function (entry) {
        return entry.event === "COMPOSER_TRANSITION" && entry.meta.transition === "READY_DRAFT -> ACTIVE";
    }));
    assert.ok(harness.trace.some(function (entry) { return entry.event === "GENERATION_ACTIVE_ENTER"; }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
});

test("short answer completes on active to ready empty", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: [],
        assistantMessageIds: [],
        composerState: "READY_EMPTY",
        composerPrimaryLabel: "开始语音",
        composerPrimaryType: "button",
    }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: [],
        composerState: "READY_DRAFT",
        composerPrimaryLabel: "发送",
        composerPrimaryType: "submit",
    }));
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: [],
        composerState: "ACTIVE",
        composerPrimaryLabel: "停止",
        composerPrimaryType: "button",
    }));
    harness.controller.noteDom(turnDom({
        assistantChanged: true,
        composerState: "ACTIVE",
        composerPrimaryLabel: "停止",
        composerPrimaryType: "button",
    }));
    harness.advance(10000);
    assert.deepEqual(harness.notifications, []);
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        composerState: "READY_EMPTY",
        composerPrimaryLabel: "开始语音",
        composerPrimaryType: "button",
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].messageId, "assistant-1");
    assert.equal(harness.notifications[0].reason, "GENERATION_SETTLED");
    assert.ok(harness.trace.some(function (entry) {
        return entry.event === "COMPOSER_TRANSITION" && entry.meta.transition === "ACTIVE -> READY_EMPTY";
    }));
    assert.ok(harness.trace.some(function (entry) {
        return entry.event === "COMPOSER_STATE_READY_EMPTY"
            && entry.meta.primaryLabel === "开始语音"
            && entry.meta.primaryType === "button";
    }));
    assert.ok(harness.trace.some(function (entry) { return entry.event === "GENERATION_IDLE_ENTER"; }));
    assert.ok(harness.trace.some(function (entry) { return entry.event === "PRIMARY_COMPLETION_PATH"; }));
    assert.equal(harness.trace.some(function (entry) { return entry.event === "FALLBACK_COMPLETION_PATH"; }), false);
});

test("thinking stays silent until active returns to ready empty", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(dom({
        userMessageIds: ["user-1"],
        assistantMessageIds: [],
        composerState: "ACTIVE",
    }));
    harness.controller.noteDom(turnDom({
        assistantMessageIds: ["assistant-thinking"],
        assistantChanged: true,
        composerState: "ACTIVE",
    }));
    harness.controller.noteDom(turnDom({
        assistantMessageIds: ["assistant-thinking"],
        assistantChanged: false,
        composerState: "ACTIVE",
    }));
    harness.advance(2000);
    assert.deepEqual(harness.notifications, []);
    assert.equal(harness.trace.some(function (entry) { return entry.event === "GENERATION_IDLE_ENTER"; }), false);
    harness.controller.noteDom(turnDom({
        assistantMessageIds: ["assistant-thinking", "assistant-final"],
        assistantChanged: true,
        composerState: "ACTIVE",
    }));
    harness.advance(2000);
    assert.deepEqual(harness.notifications, []);
    harness.controller.noteDom(turnDom({
        assistantMessageIds: ["assistant-thinking", "assistant-final"],
        assistantChanged: false,
        composerState: "READY_EMPTY",
        composerPrimaryLabel: "开始语音",
        composerPrimaryType: "button",
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].messageId, "assistant-final");
    assert.ok(harness.trace.some(function (entry) { return entry.event === "PRIMARY_COMPLETION_PATH"; }));
});

test("active returning to a draft still completes the turn", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(turnDom({
        assistantChanged: true,
        composerState: "ACTIVE",
        composerPrimaryLabel: "停止",
        composerPrimaryType: "button",
    }));
    harness.advance(2000);
    assert.deepEqual(harness.notifications, []);
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        composerState: "READY_DRAFT",
        composerPrimaryLabel: "发送",
        composerPrimaryType: "submit",
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.ok(harness.trace.some(function (entry) {
        return entry.event === "COMPOSER_TRANSITION" && entry.meta.transition === "ACTIVE -> READY_DRAFT";
    }));
    assert.ok(harness.trace.some(function (entry) {
        return entry.event === "GENERATION_IDLE_ENTER" && entry.meta.composerState === "READY_DRAFT";
    }));
    assert.ok(harness.trace.some(function (entry) { return entry.event === "PRIMARY_COMPLETION_PATH"; }));
});

test("active to unknown waits for ready empty before notifying", function () {
    const harness = createHarness();
    baseline(harness.controller, [], []);
    harness.controller.noteDom(turnDom({
        assistantChanged: true,
        composerState: "ACTIVE",
        composerPrimaryLabel: "停止",
        composerPrimaryType: "button",
    }));
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        composerState: "UNKNOWN",
        composerPrimaryLabel: null,
        composerPrimaryType: null,
    }));
    harness.advance(5000);
    assert.deepEqual(harness.notifications, []);
    assert.equal(harness.controller.getState().composerActiveSeen, true);
    assert.equal(harness.trace.some(function (entry) { return entry.event === "GENERATION_IDLE_ENTER"; }), false);
    assert.ok(harness.trace.some(function (entry) { return entry.event === "COMPOSER_STATE_UNKNOWN"; }));
    assert.ok(blockedReasons(harness).indexOf("generation_active") !== -1);
    harness.controller.noteDom(turnDom({
        assistantChanged: false,
        composerState: "READY_EMPTY",
        composerPrimaryLabel: "开始语音",
        composerPrimaryType: "button",
    }));
    harness.advance(800);
    assert.equal(harness.notifications.length, 1);
    assert.ok(harness.trace.some(function (entry) {
        return entry.event === "COMPOSER_TRANSITION" && entry.meta.transition === "UNKNOWN -> READY_EMPTY";
    }));
    assert.ok(harness.trace.some(function (entry) { return entry.event === "PRIMARY_COMPLETION_PATH"; }));
    assert.equal(harness.trace.some(function (entry) { return entry.event === "FALLBACK_COMPLETION_PATH"; }), false);
});

test("anonymous /uc route promotion keeps the first response and history switches cancel it", function () {
    const h = createHarness();
    assert.equal(sandbox.ChatGPTCompletion.conversationKeyFromUrl('https://chatgpt.com/uc/anonymous-id'), 'c:anonymous-id');
    h.controller.noteRouteChange('https://chatgpt.com/');
    h.controller.noteBaseline({ userMessageIds: [], assistantMessageIds: [] });
    h.controller.noteDom({ userMessageIds: ['u1'], assistantMessageIds: ['a1'], composerState: 'ACTIVE' });
    h.controller.noteRouteChange('https://chatgpt.com/uc/anonymous-id');
    h.controller.noteDom({ userMessageIds: ['u1'], assistantMessageIds: ['a1'], composerState: 'READY_EMPTY' });
    h.advance(800); assert.equal(h.notifications.length, 1);
    h.controller.noteDom({ userMessageIds: ['u1', 'u2'], assistantMessageIds: ['a1', 'a2'], composerState: 'ACTIVE' });
    h.controller.noteRouteChange('https://chatgpt.com/uc/another-id');
    h.controller.noteDom({ userMessageIds: ['historic-u'], assistantMessageIds: ['historic-a'], composerState: 'READY_EMPTY' });
    h.advance(5000); assert.equal(h.notifications.length, 1);
});
