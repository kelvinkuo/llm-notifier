(function () {
    "use strict";

    function createController({ schedule = setTimeout, cancel = clearTimeout, read, onCompleted, settleMs = 1000 }) {
        let phase = "IDLE";
        let sequence = 0;
        let turn = null;
        let timer = null;
        let route = null;
        function clear() {
            if (timer !== null) cancel(timer);
            timer = null;
        }
        function reset() {
            clear();
            turn = null;
            phase = "IDLE";
        }
        function noteRoute(path) {
            if (route !== null && route !== path) {
                // Sending the first prompt promotes the draft to a conversation URL.
                if (!(route === "/app" && /^\/app\/[^/]+$/.test(path) && turn)) reset();
            }
            route = path;
        }
        function submit(view) {
            if (view.generating) return;
            // An explicit next submission with the same completed footer is an additional
            // end-of-turn confirmation. Do not lose the prior sound to fast follow-ups.
            if (turn && phase === "SETTLING" && view.idle && view.ready && !view.busy && !view.failed
                && turn.signature === `${view.responseId}:${view.revision}`) {
                onCompleted({ sequence: turn.sequence });
            }
            clear();
            turn = { sequence: ++sequence, baseline: view.responseId, responseId: null, seen: false };
            phase = "IDLE";
        }
        function observe(view) {
            if (!turn) return;
            if (view.failed) { reset(); return; }
            if (view.generating || view.busy) {
                turn.seen = true;
                if (view.responseId && view.responseId !== turn.baseline) turn.responseId = view.responseId;
                clear();
                phase = "GENERATING";
                return;
            }
            const complete = turn.seen && view.idle && view.ready
                && view.responseId && view.responseId !== turn.baseline
                && (!turn.responseId || turn.responseId === view.responseId);
            if (!complete) {
                clear();
                phase = turn.seen ? "GENERATING" : "IDLE";
                return;
            }
            const signature = `${view.responseId}:${view.revision}`;
            if (timer !== null && turn.signature === signature) return;
            clear();
            turn.signature = signature;
            phase = "SETTLING";
            timer = schedule(function () {
                timer = null;
                // Re-read the live DOM; background timer throttling must never complete a stale snapshot.
                const current = read();
                if (turn && !current.failed && !current.generating && !current.busy && current.idle && current.ready
                    && `${current.responseId}:${current.revision}` === signature) {
                    const completedSequence = turn.sequence;
                    turn = null;
                    phase = "COMPLETED";
                    onCompleted({ sequence: completedSequence });
                } else {
                    observe(current);
                }
            }, settleMs);
        }
        return { submit, observe, reset, noteRoute, getState: () => ({ phase, sequence }) };
    }
    globalThis.GeminiCompletion = { createController };
})();
