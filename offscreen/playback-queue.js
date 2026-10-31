export function createAudioQueue(audio, { schedule = setTimeout, cancel = clearTimeout, timeoutMs = 15000 } = {}) {
    let tail = Promise.resolve();
    function play(onEvent) {
        function report(event) { try { onEvent(event); } catch { /* Diagnostics only. */ } }
        return new Promise((resolve, reject) => {
            if (!audio) { reject(new Error("Notification audio element missing")); return; }
            let done = false;
            let timer;
            function finish(error) {
                if (done) return;
                done = true;
                cancel(timer);
                audio.removeEventListener("ended", ended);
                audio.removeEventListener("error", failed);
                if (error) { audio.pause(); reject(error); }
                else resolve({ ok: true });
            }
            const ended = () => finish();
            const failed = () => finish(new Error("Notification audio decoding/playback failed"));
            audio.addEventListener("ended", ended);
            audio.addEventListener("error", failed);
            timer = schedule(() => finish(new Error("Notification audio playback timed out")), timeoutMs);
            try {
                audio.currentTime = 0;
                report("AUDIO_PLAY_STARTED");
                Promise.resolve(audio.play()).then(() => report("AUDIO_PLAY_ACCEPTED")).catch(finish);
            } catch (error) { finish(error); }
        });
    }
    return function enqueue(onEvent = () => {}) {
        const result = tail.then(() => play(onEvent));
        tail = result.catch(() => {});
        return result;
    };
}
