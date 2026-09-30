import assert from "node:assert/strict";
import test from "node:test";
import { classifyChatGPTRequest, hintForChatGPTRequest, isChatGPTPageUrl, sanitizePageUrl } from "./chatgpt-url.js";

test("classifies conversation requests by host, path, and method", function () {
    assert.equal(
        classifyChatGPTRequest("https://chatgpt.com/backend-api/f/conversation", "POST"),
        "conversation",
    );
    assert.equal(
        classifyChatGPTRequest("https://chatgpt.com/backend-api/conversation?stream=true", "POST"),
        "conversation",
    );
    assert.equal(
        classifyChatGPTRequest("https://chatgpt.com/backend-api/f/conversation/", "post"),
        "conversation",
    );
    assert.equal(
        classifyChatGPTRequest("https://chat.openai.com/backend-api/f/conversation", "POST"),
        "conversation",
    );
    assert.equal(
        classifyChatGPTRequest("https://chatgpt.com/backend-api/f/conversation/prepare", "POST"),
        "prepare",
    );
    assert.equal(
        classifyChatGPTRequest("https://chatgpt.com/backend-api/f/conversation/finalize?x=1", "POST"),
        "finalize",
    );
    assert.equal(
        classifyChatGPTRequest("https://chatgpt.com/backend-api/f/finalize", "POST"),
        "finalize",
    );
});

test("ignores unrelated hosts, methods, and telemetry paths", function () {
    assert.equal(classifyChatGPTRequest("https://chatgpt.com/backend-api/f/conversation", "GET"), null);
    assert.equal(classifyChatGPTRequest("https://evil.com/backend-api/f/conversation", "POST"), null);
    assert.equal(classifyChatGPTRequest("https://chatgpt.com/backend-api/f/rgstr?k=1", "POST"), null);
    assert.equal(classifyChatGPTRequest("https://chatgpt.com/backend-api/f/flush", "POST"), null);
    assert.equal(classifyChatGPTRequest("not a url", "POST"), null);
    assert.equal(
        classifyChatGPTRequest("https://gemini.google.com/backend-api/f/conversation", "POST"),
        null,
    );
});

test("matches ChatGPT page hosts and strips query data from page urls", function () {
    assert.equal(isChatGPTPageUrl("https://chatgpt.com/c/abc?q=1"), true);
    assert.equal(isChatGPTPageUrl("https://www.chatgpt.com/"), true);
    assert.equal(isChatGPTPageUrl("https://chat.openai.com/c/abc"), true);
    assert.equal(isChatGPTPageUrl("https://gemini.google.com/"), false);
    assert.equal(isChatGPTPageUrl("not a url"), false);
    assert.equal(sanitizePageUrl("https://chatgpt.com/c/abc?q=1#hash"), "https://chatgpt.com/c/abc");
});

test("maps network phases to hints without treating them as completion", function () {
    assert.equal(hintForChatGPTRequest("conversation", "start", undefined), "RESPONSE_REQUEST_STARTED");
    assert.equal(hintForChatGPTRequest("conversation", "end", 200), "RESPONSE_STREAM_ENDED");
    assert.equal(hintForChatGPTRequest("conversation", "end", 500), "RESPONSE_FAILED");
    assert.equal(hintForChatGPTRequest("conversation", "error", 0), "RESPONSE_FAILED");
    assert.equal(hintForChatGPTRequest("prepare", "end", 200), "PREPARE_SEEN");
    assert.equal(hintForChatGPTRequest("finalize", "end", 200), "FINALIZE_SEEN");
    assert.equal(hintForChatGPTRequest("finalize", "end", 500), null);
    assert.equal(hintForChatGPTRequest("prepare", "start", 200), null);
});
