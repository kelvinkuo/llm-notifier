import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('./completion-machine.js', import.meta.url), 'utf8');
function harness() {
    const sandbox = {};
    vm.runInNewContext(source, sandbox);
    let time = 0, next = 0;
    const timers = new Map(), events = [];
    let view = { idle: true, ready: true, responseId: 'history', revision: 0 };
    const controller = sandbox.GeminiCompletion.createController({
        schedule(fn, ms) { const id = ++next; timers.set(id, { fn, at: time + ms }); return id; },
        cancel(id) { timers.delete(id); },
        read: () => view,
        onCompleted: e => events.push(e.sequence),
    });
    controller.noteRoute('/app/existing');
    return {
        controller, events,
        update(patch) { view = { ...view, ...patch }; controller.observe(view); },
        silent(patch) { view = { ...view, ...patch }; },
        submit() { controller.submit(view); },
        start(id = 'new') { this.submit(); this.update({ generating: true, busy: true, ready: false, responseId: id }); },
        finish() { this.update({ generating: false, busy: false, ready: true }); },
        advance(ms) {
            time += ms;
            for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
        },
    };
}
test('normal completion once, consecutive turns once each', () => {
    const h = harness(); h.start(); h.finish(); h.advance(1000);
    h.update({}); h.advance(10000); assert.deepEqual(h.events, [1]);
    h.start('second'); h.finish(); h.advance(1000); assert.deepEqual(h.events, [1, 2]);
});
test('long generation and partial idle never complete without positive footer and busy=false', () => {
    const h = harness(); h.start(); h.advance(3600000);
    h.update({ generating: false }); h.advance(10000);
    h.update({ busy: false }); h.advance(10000);
    assert.deepEqual(h.events, []);
    h.finish(); h.advance(1000); assert.deepEqual(h.events, [1]);
});
test('UI jitter and response mutations restart settling', () => {
    const h = harness(); h.start(); h.finish(); h.advance(900);
    h.update({ generating: true }); h.advance(2000); assert.deepEqual(h.events, []);
    h.finish(); h.advance(900); h.update({ revision: 1 }); h.advance(900);
    assert.deepEqual(h.events, []); h.advance(100); assert.deepEqual(h.events, [1]);
});
test('re-read live state before completion even when background delivery is delayed', () => {
    const h = harness(); h.start(); h.finish(); h.silent({ busy: true }); h.advance(100000);
    assert.deepEqual(h.events, []);
    h.finish(); h.advance(1000); assert.deepEqual(h.events, [1]);
});
test('stop, failure, and historical response never notify; following turn recovers', () => {
    for (const reason of ['stop', 'failure']) {
        const h = harness(); h.update({}); h.advance(5000); h.start();
        if (reason === 'stop') h.controller.reset(); else h.update({ failed: true });
        h.finish(); h.advance(5000); assert.deepEqual(h.events, []);
        h.update({ failed: false }); h.start('recovered'); h.finish(); h.advance(1000);
        assert.deepEqual(h.events, [2]);
    }
});
test('refresh during generation, history navigation, and missing composer suppress completion', () => {
    const h = harness(); h.update({ generating: true, busy: true }); h.finish(); h.advance(5000);
    assert.deepEqual(h.events, []);
    h.start(); h.finish(); h.controller.noteRoute('/app/history'); h.advance(5000);
    assert.deepEqual(h.events, []);
    h.start('next'); h.finish(); h.update({ idle: false }); h.advance(5000);
    assert.deepEqual(h.events, []); h.update({ idle: true }); h.advance(1000); assert.deepEqual(h.events, [2]);
});
test('draft URL promotion preserves a turn but subsequent route change cancels', () => {
    const h = harness(); h.controller.noteRoute('/app'); h.start(); h.controller.noteRoute('/app/created');
    h.finish(); h.advance(1000); assert.deepEqual(h.events, [1]);
});
test('two independent tabs may settle simultaneously', () => {
    const a = harness(), b = harness(); a.start(); b.start(); a.finish(); a.advance(1000);
    assert.deepEqual(a.events, [1]); assert.deepEqual(b.events, []);
    b.finish(); b.advance(1000); assert.deepEqual(b.events, [1]);
});
test('a fast follow-up confirms the pending completed footer and both turns notify', () => {
    const h = harness(); h.start(); h.finish(); h.advance(100);
    h.start('fast-followup'); assert.deepEqual(h.events, [1]);
    h.finish(); h.advance(1000); assert.deepEqual(h.events, [1, 2]);
});
test('next submission recovers after a failed response without a normal footer or alert', () => {
    const h = harness(); h.start(); h.update({ generating: false, busy: false, ready: false });
    h.advance(10000); assert.deepEqual(h.events, []);
    h.start('recovered'); h.finish(); h.advance(1000); assert.deepEqual(h.events, [2]);
});
