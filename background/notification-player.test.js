import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotificationPlayer } from './notification-player.js';
import { createAudioQueue } from '../offscreen/playback-queue.js';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('simultaneous notifications reuse offscreen and wait for each sound acknowledgment', async () => {
    let exists = false, created = 0, sent = 0;
    const completions = [];
    const chrome = {
        offscreen: {
            hasDocument: async () => exists,
            createDocument: async () => { created++; exists = true; },
            closeDocument() { assert.fail('must not interrupt playback'); },
        },
        runtime: { sendMessage: () => { sent++; return new Promise(resolve => completions.push(resolve)); } },
    };
    const enqueue = createNotificationPlayer(chrome, 'offscreen/offscreen.html');
    const a = enqueue(), b = enqueue();
    await flush(); assert.equal(created, 1); assert.equal(sent, 1);
    completions.shift()({ ok: true }); await a; await flush(); assert.equal(sent, 2);
    completions.shift()({ ok: true }); await b;
    exists = false;
    const c = enqueue(); await flush(); assert.equal(created, 2);
    completions.shift()({ ok: true }); await c;
});
test('offscreen failure is explicit and the next sound still runs', async () => {
    let sent = 0;
    const enqueue = createNotificationPlayer({
        offscreen: { hasDocument: async () => true },
        runtime: { sendMessage: async () => ++sent === 1 ? { ok: false, error: 'decode failed' } : { ok: true } },
    }, 'offscreen.html');
    const a = enqueue(), b = enqueue();
    await assert.rejects(a, /decode failed/); await b; assert.equal(sent, 2);
});
function fakeAudio() {
    const handlers = new Map();
    return {
        plays: 0, pauses: 0, currentTime: 12,
        addEventListener(name, fn) { handlers.set(name, fn); },
        removeEventListener(name) { handlers.delete(name); },
        play() { this.plays++; return Promise.resolve(); },
        pause() { this.pauses++; },
        emit(name) { handlers.get(name)?.(); },
    };
}
test('audio queue never restarts an active sound and acknowledges each ended event', async () => {
    const audio = fakeAudio(), enqueue = createAudioQueue(audio);
    const a = enqueue(), b = enqueue(); await flush();
    assert.equal(audio.plays, 1); assert.equal(audio.currentTime, 0);
    audio.emit('ended'); assert.deepEqual(await a, { ok: true }); await flush();
    assert.equal(audio.plays, 2); audio.emit('ended'); await b; assert.equal(audio.pauses, 0);
});
test('audio errors, play rejection and timeouts release the queue', async () => {
    for (const failure of ['error', 'reject', 'timeout']) {
        const audio = fakeAudio(); let timeout;
        const enqueue = createAudioQueue(audio, { schedule(fn) { timeout = fn; return 1; }, cancel() {} });
        if (failure === 'reject') audio.play = () => Promise.reject(new Error('blocked'));
        const a = enqueue(); const rejected = assert.rejects(a);
        await flush();
        if (failure === 'error') audio.emit('error');
        if (failure === 'timeout') timeout();
        await rejected;
        audio.play = function () { this.plays++; return Promise.resolve(); };
        const b = enqueue(); await flush(); audio.emit('ended'); await b;
    }
});

test('diagnostics correlate queue, offscreen and result without changing Gemini playback', async () => {
    const events = [], sent = [];
    const chrome = {
        offscreen: { hasDocument: async () => false, createDocument: async () => {} },
        runtime: { sendMessage: async payload => { sent.push(payload); return { ok: true }; } },
    };
    const enqueue = createNotificationPlayer(chrome, 'offscreen.html', { onEvent: (event, trace) => events.push({ event, trace }) });
    await enqueue({ provider: 'ChatGPT', diagnosticId: 'doc-test', sequence: 3, tabId: 7 });
    assert.deepEqual(events.map(e => e.event), ['NOTIFICATION_QUEUED', 'OFFSCREEN_CHECK', 'OFFSCREEN_CREATED', 'OFFSCREEN_DISPATCH', 'AUDIO_PLAY_SUCCEEDED']);
    assert.ok(events.every(e => e.trace.diagnosticId === 'doc-test' && e.trace.tabId === 7 && e.trace.sequence === 3 && e.trace.time));
    assert.equal(sent[0].trace.sequence, 3);
    const previous = events.length;
    await enqueue({ provider: 'Gemini' }); assert.equal(events.length, previous);
});

test('diagnostic failures report the stage and redact URLs; observer failure cannot break audio', async () => {
    const events = [];
    const enqueue = createNotificationPlayer({
        offscreen: { hasDocument: async () => false, createDocument: async () => { throw new Error('failed https://example.test/?token=SECRET'); } },
    }, 'offscreen.html', { onEvent: (event, trace) => events.push({ event, trace }) });
    await assert.rejects(enqueue({ provider: 'ChatGPT' }));
    assert.equal(events.at(-1).event, 'AUDIO_PLAY_FAILED');
    assert.equal(events.at(-1).trace.stage, 'OFFSCREEN_CREATE');
    assert.ok(!JSON.stringify(events).includes('SECRET'));
    const audio = fakeAudio();
    const play = createAudioQueue(audio);
    const result = play(() => { throw new Error('diagnostic sink failure'); });
    await flush(); audio.emit('ended'); assert.deepEqual(await result, { ok: true });
});

test('audio diagnostics distinguish play invocation and browser acceptance', async () => {
    const audio = fakeAudio(), events = [];
    const result = createAudioQueue(audio)(event => events.push(event));
    await flush();
    assert.deepEqual(events, ['AUDIO_PLAY_STARTED', 'AUDIO_PLAY_ACCEPTED']);
    audio.emit('ended'); await result;
});
