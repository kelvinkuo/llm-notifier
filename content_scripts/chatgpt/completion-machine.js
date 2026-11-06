(function () {
    "use strict";

    function createController({ read, onCompleted, onDebug = () => {}, settleMs = 800,
        schedule = setTimeout, cancel = clearTimeout }) {
        let phase = "IDLE";
        let sequence = 0;
        let timer = null;
        function clear() {
            if (timer !== null) cancel(timer);
            timer = null;
        }
        function transition(next, reason) {
            if (phase === next) return;
            const from = phase;
            phase = next;
            onDebug("STATE_CHANGED", { from, to: next, sequence, reason });
        }
        function observe(view) {
            const state = view?.state || "UNKNOWN";
            if (state === "ACTIVE") {
                clear();
                if (phase === "IDLE") {
                    sequence += 1;
                    onDebug("GENERATION_STARTED", { sequence });
                }
                transition("GENERATING", "stop-control");
            } else if (state !== "READY") {
                clear();
                if (phase === "SETTLING") transition("GENERATING", "controls-unknown");
            } else if (phase === "GENERATING") {
                transition("SETTLING", "idle-control-restored");
                timer = schedule(function () {
                    timer = null;
                    let current;
                    try { current = read(); }
                    catch {
                        onDebug("READ_FAILED", { sequence });
                        current = { state: "UNKNOWN" };
                    }
                    // Re-read live controls, including when a background timer fires late.
                    if (current?.state !== "READY") { observe(current); return; }
                    transition("IDLE", "idle-stable");
                    onDebug("COMPLETION_CONFIRMED", { sequence });
                    onCompleted({ sequence, reason: "PAGE_GENERATION_ENDED" });
                }, settleMs);
            }
        }
        return { observe, getState: () => ({ phase, sequence }), dispose: clear };
    }
    globalThis.ChatGPTCompletion = { createController };
})();
