import assert from 'node:assert/strict';
import test from 'node:test';
import { isChatGPTPageUrl, sanitizePageUrl } from './chatgpt-url.js';
test('validates ChatGPT senders without interpreting their conversation paths', () => {
    for (const host of ['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']) {
        for (const path of ['/', '/c/example', '/uc/example', '/g/example/c/other']) {
            assert.equal(isChatGPTPageUrl(`https://${host}${path}`), true);
        }
    }
    assert.equal(isChatGPTPageUrl('https://gemini.google.com/'), false);
    assert.equal(isChatGPTPageUrl('https://chatgpt.com.evil.test/'), false);
    assert.equal(isChatGPTPageUrl('invalid'), false);
});
test('diagnostic URLs omit query and hash', () => {
    assert.equal(sanitizePageUrl('https://chatgpt.com/c/test?token=PRIVATE#PRIVATE'), 'https://chatgpt.com/c/test');
});
