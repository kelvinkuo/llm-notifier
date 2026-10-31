import assert from 'node:assert/strict';
import test from 'node:test';

const flush = () => new Promise(resolve => setImmediate(resolve));
test('diagnostic handshake returns tabId and offscreen milestones reach the worker console', async () => {
    const oldChrome = globalThis.chrome, oldLog = console.log;
    const logs = [], runtimeListeners = [];
    const event = () => ({ addListener() {} });
    globalThis.chrome = {
        runtime: {
            onMessage: { addListener(fn) { runtimeListeners.push(fn); } },
            getURL: path => `chrome-extension://fixture/${path}`,
            getManifest: () => ({ version: '1.5.1' }),
            sendMessage: async () => ({ ok: true }),
        },
        webRequest: { onBeforeRequest: event(), onCompleted: event(), onErrorOccurred: event() },
        webNavigation: { onHistoryStateUpdated: event() },
        offscreen: { hasDocument: async () => true },
    };
    console.log = (...args) => logs.push(args);
    try {
        await import('./service-worker.js?diagnostic-test');
        const receive = runtimeListeners[0];
        const sender = { tab: { id: 17 }, frameId: 0, url: 'https://chatgpt.com/c/test?token=PRIVATE_QUERY' };
        let acknowledgment;
        receive({ type: 'chatgpt_detector_ready', diagnosticId: 'doc-test', debug: true }, sender, value => { acknowledgment = value; });
        assert.deepEqual(acknowledgment, { ok: true, tabId: 17 });
        receive({ action: 'play_sound', provider: 'ChatGPT', sequence: 2, diagnosticId: 'doc-test', debug: true }, sender, () => {});
        await flush();
        const output = JSON.stringify(logs);
        for (const event of ['CHATGPT_DETECTOR_READY', 'PLAY_SOUND_RECEIVED', 'OFFSCREEN_REUSED', 'AUDIO_PLAY_SUCCEEDED']) {
            assert.ok(output.includes(event), event);
        }
        assert.ok(!output.includes('PRIVATE_QUERY'));
        const before = logs.length;
        receive({ type: 'NOTIFICATION_DIAGNOSTIC', event: 'AUDIO_PLAY_STARTED', trace: { tabId: 17, sequence: 2, diagnosticId: 'doc-test' } }, {
            url: 'chrome-extension://fixture/offscreen/offscreen.html',
        }, () => {});
        assert.equal(logs.length, before + 1);
        assert.ok(JSON.stringify(logs.at(-1)).includes('AUDIO_PLAY_STARTED'));
        receive({ type: 'NOTIFICATION_DIAGNOSTIC', event: 'FORGED_AUDIO_EVENT' }, sender, () => {});
        assert.ok(!JSON.stringify(logs).includes('FORGED_AUDIO_EVENT'));
    } finally {
        globalThis.chrome = oldChrome; console.log = oldLog;
    }
});
