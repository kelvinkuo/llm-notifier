import assert from 'node:assert/strict';
import test from 'node:test';
import provider from './chatgpt.js';
function logger() { return { info() {}, warn() {}, error() {} }; }
const sender = { frameId: 0, url: 'https://chatgpt.com/c/test?token=PRIVATE', tab: { id: 7 } };
test('ChatGPT provider only bridges runtime events; no network or navigation handlers remain', () => {
    assert.equal(typeof provider.handleRuntimeMessage, 'function');
    for (const capability of ['requestFilter', 'handleBeforeRequest', 'handleCompleted', 'handleError', 'navigation']) {
        assert.equal(provider[capability], undefined);
    }
});
test('one page completion reaches the queue with correlation and waits for playback', async () => {
    let played = 0, trace;
    const result = provider.handleRuntimeMessage({ action: 'play_sound', provider: 'ChatGPT',
        sequence: 2, reason: 'PAGE_GENERATION_ENDED', diagnosticId: 'doc-test' }, sender, {
        logger: logger(), playNotification: async value => { played++; trace = value; return { ok: true }; },
    });
    assert.deepEqual(await result, { ok: true });
    assert.equal(played, 1); assert.equal(trace.sequence, 2); assert.equal(trace.diagnosticId, 'doc-test');
    assert.ok(!JSON.stringify(trace).includes('PRIVATE'));
});
test('playback failures propagate to the worker for an explicit negative acknowledgment', async () => {
    await assert.rejects(provider.handleRuntimeMessage({ action: 'play_sound', provider: 'ChatGPT' }, sender, {
        logger: logger(), playNotification: async () => { throw new Error('audio unavailable'); },
    }), /audio unavailable/);
});
test('iframe, other hosts, other providers and ready handshake never play', () => {
    let played = 0;
    const context = { logger: logger(), playNotification: async () => { played++; } };
    const message = { action: 'play_sound', provider: 'ChatGPT' };
    provider.handleRuntimeMessage(message, { ...sender, frameId: 1 }, context);
    provider.handleRuntimeMessage(message, { ...sender, url: 'https://evil.test/' }, context);
    provider.handleRuntimeMessage({ ...message, provider: 'Gemini' }, sender, context);
    provider.handleRuntimeMessage({ type: 'chatgpt_detector_ready' }, sender, context);
    assert.equal(played, 0);
});
