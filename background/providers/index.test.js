import assert from "node:assert/strict";
import test from "node:test";
import providers from "./index.js";

test("registry lists Gemini and ChatGPT in registration order", function () {
    assert.deepEqual(providers.map(function (provider) { return provider.name; }), ["Gemini", "ChatGPT"]);
});

test("providers declare only the capabilities they use", function () {
    const gemini = providers[0];
    const chatgpt = providers[1];

    assert.equal(gemini.requestFilter, undefined);
    assert.equal(gemini.handleCompleted, undefined);
    assert.equal(typeof gemini.handleRuntimeMessage, "function");

    assert.equal(typeof chatgpt.handleBeforeRequest, "function");
    assert.equal(typeof chatgpt.handleCompleted, "function");
    assert.equal(typeof chatgpt.handleError, "function");
    assert.equal(typeof chatgpt.handleRuntimeMessage, "function");
    assert.equal(typeof chatgpt.navigation.onHistoryStateUpdated, "function");
    assert.deepEqual(chatgpt.navigation.url, [
        { hostEquals: "chatgpt.com" },
        { hostEquals: "www.chatgpt.com" },
        { hostEquals: "chat.openai.com" },
    ]);
});
