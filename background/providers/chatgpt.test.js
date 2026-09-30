import assert from "node:assert/strict";
import test from "node:test";
import chatgptProvider, { forwardChatGPTRouteChange } from "./chatgpt.js";

function logger() {
    return {
        warnings: [],
        infos: [],
        errors: [],
        warn: function (message) { this.warnings.push(message); },
        info: function (message) { this.infos.push(message); },
        error: function (message) { this.errors.push(message); },
        debug: function () {},
    };
}

test("chatgpt play_sound from the top frame reaches shared notification", function () {
    let played = 0;
    const sink = logger();
    chatgptProvider.handleRuntimeMessage({
        action: "play_sound",
        provider: "ChatGPT",
        reason: "GENERATION_SETTLED",
        sequence: 1,
        messageId: "assistant-1",
        debug: false,
    }, {
        frameId: 0,
        url: "https://chatgpt.com/c/abc?q=1",
        tab: { id: 7 },
    }, {
        playNotification: function () {
            played += 1;
            return Promise.resolve();
        },
        logger: sink,
        offscreenPath: "offscreen/offscreen.html",
    });
    assert.equal(played, 1);
    assert.deepEqual(sink.infos, ["收到 ChatGPT 完成事件，准备播放提示音。"]);
});

test("chatgpt runtime messages do not play for iframes, other hosts, or other providers", function () {
    const cases = [
        {
            message: { action: "play_sound", provider: "ChatGPT" },
            sender: { frameId: 1, url: "https://chatgpt.com/" },
        },
        {
            message: { action: "play_sound", provider: "ChatGPT" },
            sender: { frameId: 0, url: "https://gemini.google.com/" },
        },
        {
            message: { action: "play_sound", provider: "Gemini" },
            sender: { frameId: 0, url: "https://chatgpt.com/" },
        },
        {
            message: { type: "chatgpt_detector_ready", debug: false },
            sender: { url: "https://chatgpt.com/", tab: { id: 1 } },
        },
    ];

    for (const entry of cases) {
        let played = 0;
        chatgptProvider.handleRuntimeMessage(entry.message, entry.sender, {
            playNotification: function () {
                played += 1;
                return Promise.resolve();
            },
            logger: logger(),
            offscreenPath: "offscreen/offscreen.html",
        });
        assert.equal(played, 0);
    }
});

test("chatgpt network completion forwards a hint and does not play sound", function () {
    const sent = [];
    const previous = globalThis.chrome;
    globalThis.chrome = {
        tabs: {
            sendMessage: function (tabId, payload) {
                sent.push({ tabId: tabId, payload: payload });
                return Promise.resolve();
            },
        },
    };
    try {
        let played = 0;
        chatgptProvider.handleCompleted({
            url: "https://chatgpt.com/backend-api/f/conversation",
            method: "POST",
            statusCode: 200,
            tabId: 3,
            requestId: "r1",
        }, {
            playNotification: function () { played += 1; },
            logger: logger(),
        });
        assert.equal(played, 0);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].tabId, 3);
        assert.equal(sent[0].payload.type, "CHATGPT_NETWORK_HINT");
        assert.equal(sent[0].payload.hint, "RESPONSE_STREAM_ENDED");
    } finally {
        globalThis.chrome = previous;
    }
});

test("chatgpt route changes are forwarded only for the top frame", function () {
    const sent = [];
    function sendMessage(tabId, payload) {
        sent.push({ tabId: tabId, payload: payload });
        return Promise.resolve();
    }

    forwardChatGPTRouteChange({
        frameId: 0,
        tabId: 4,
        url: "https://chatgpt.com/c/abc?q=1#hash",
    }, sendMessage);
    forwardChatGPTRouteChange({
        frameId: 2,
        tabId: 4,
        url: "https://chatgpt.com/c/abc",
    }, sendMessage);
    forwardChatGPTRouteChange({
        frameId: 0,
        tabId: 4,
        url: "not a url",
    }, sendMessage);

    assert.deepEqual(sent, [{
        tabId: 4,
        payload: {
            type: "CHATGPT_ROUTE_CHANGED",
            url: "https://chatgpt.com/c/abc",
        },
    }]);
});
