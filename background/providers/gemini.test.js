import assert from "node:assert/strict";
import test from "node:test";
import { createGeminiProvider } from "./gemini.js";

const message = { action: "play_sound", provider: "Gemini", session: "test-session", sequence: 1 };
function sender(id = 1, documentId = 'doc') {
    return { tab: { id }, documentId, frameId: 0, url: "https://gemini.google.com/app/test" };
}
function harness() {
    const provider = createGeminiProvider();
    let played = 0;
    const context = { playNotification: async () => { played++; }, logger: { error() {} } };
    return { provider, context, played: () => played };
}
test("Gemini deduplicates per document and sequence, not across tabs", async () => {
    const h = harness();
    await Promise.all([1, 2].map(id => h.provider.handleRuntimeMessage(message, sender(id), h.context)));
    await h.provider.handleRuntimeMessage(message, sender(), h.context);
    await h.provider.handleRuntimeMessage({ ...message, sequence: 2 }, sender(), h.context);
    await h.provider.handleRuntimeMessage(message, sender(1, 'reloaded'), h.context);
    assert.equal(h.played(), 4);
    assert.equal(h.provider.requestFilter, undefined);
});
test("Gemini rejects untrusted senders and malformed events", () => {
    const h = harness();
    for (const source of [{ ...sender(), frameId: 1 }, { ...sender(), url: 'https://evil.test/' }, { frameId: 0 }]) {
        h.provider.handleRuntimeMessage(message, source, h.context);
    }
    for (const patch of [{ provider: 'ChatGPT' }, { sequence: 0 }, { sequence: NaN }, { session: '' }]) {
        h.provider.handleRuntimeMessage({ ...message, ...patch }, sender(), h.context);
    }
    assert.equal(h.played(), 0);
});
test("sequence resets after reload even without Chrome documentId", async () => {
    const h = harness();
    await h.provider.handleRuntimeMessage(message, sender(1, undefined), h.context);
    await h.provider.handleRuntimeMessage({ ...message, session: 'new' }, { ...sender(), documentId: undefined }, h.context);
    assert.equal(h.played(), 2);
});
