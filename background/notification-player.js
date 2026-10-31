export function createNotificationPlayer(chromeApi, path, { onEvent = () => {} } = {}) {
    function traceEvent(event, trace, extra = {}) {
        if (trace.provider !== "ChatGPT") return;
        try { onEvent(event, { ...trace, ...extra, time: new Date().toISOString() }); } catch { /* Diagnostics never affect playback. */ }
    }
    let tail = Promise.resolve();
    async function play(trace) {
        let stage = "OFFSCREEN_CHECK";
        try {
            traceEvent(stage, trace);
            if (!await chromeApi.offscreen.hasDocument()) {
                stage = "OFFSCREEN_CREATE";
                await chromeApi.offscreen.createDocument({
                    url: path,
                    reasons: ["AUDIO_PLAYBACK"],
                    justification: "Play queued LLM completion notification sounds.",
                });
                traceEvent("OFFSCREEN_CREATED", trace);
            } else {
                traceEvent("OFFSCREEN_REUSED", trace);
            }
            stage = "OFFSCREEN_DISPATCH";
            traceEvent(stage, trace);
            const result = await chromeApi.runtime.sendMessage({ target: "offscreen", type: "PLAY_NOTIFICATION", trace });
            if (!result?.ok) throw new Error(result?.error || "Offscreen playback did not acknowledge completion");
            traceEvent("AUDIO_PLAY_SUCCEEDED", trace, { source: "offscreen-ended-ack" });
            return result;
        } catch (error) {
            traceEvent("AUDIO_PLAY_FAILED", trace, {
                stage, error: String(error?.message || error).replace(/https?:\/\/[^\s]+/g, "[url]"),
            });
            throw error;
        }
    }
    return function enqueue(trace = {}) {
        traceEvent("NOTIFICATION_QUEUED", trace);
        const result = tail.then(() => play(trace));
        tail = result.catch(() => {}); // A failed sound must not block subsequent completions.
        return result;
    };
}
