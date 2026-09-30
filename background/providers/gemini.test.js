import assert from "node:assert/strict";
import test from "node:test";
import geminiProvider, { isGeminiStreamComplete } from "./gemini.js";

test("gemini stream completion is a successful POST only", function () {
    assert.equal(isGeminiStreamComplete({ statusCode: 200, method: "POST" }), true);
    assert.equal(isGeminiStreamComplete({ statusCode: 200, method: "GET" }), false);
    assert.equal(isGeminiStreamComplete({ statusCode: 500, method: "POST" }), false);
});

test("gemini provider plays through the shared notification callback", function () {
    const logger = {
        info: [],
        warn: [],
    };
    let played = 0;
    geminiProvider.handleCompleted(
        { statusCode: 200, method: "POST" },
        {
            playNotification: function () { played += 1; },
            logger: {
                info: function (message) { logger.info.push(message); },
                warn: function (message) { logger.warn.push(message); },
            },
        },
    );
    assert.equal(played, 1);
    assert.deepEqual(logger.info, ["响应完成。"]);
    assert.deepEqual(logger.warn, []);
});

test("gemini provider does not play for a non-success stream", function () {
    const warnings = [];
    let played = 0;
    geminiProvider.handleCompleted(
        { statusCode: 500, method: "POST" },
        {
            playNotification: function () { played += 1; },
            logger: {
                info: function () {},
                warn: function (message) { warnings.push(message); },
            },
        },
    );
    assert.equal(played, 0);
    assert.deepEqual(warnings, ["侦测到请求但状态码为 500"]);
});
