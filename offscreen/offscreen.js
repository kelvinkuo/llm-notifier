import { createLogger } from "../shared/logger.js";
import { createAudioQueue } from "./playback-queue.js";

const logger = createLogger("Offscreen");
const enqueue = createAudioQueue(document.getElementById("notification-sound"));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== "offscreen" || message.type !== "PLAY_NOTIFICATION") return;
    const trace = message.trace || {};
    function report(event) {
        if (trace.provider !== "ChatGPT") return;
        const metadata = { ...trace, time: new Date().toISOString() };
        logger.debug(event, metadata);
        chrome.runtime.sendMessage({ type: "NOTIFICATION_DIAGNOSTIC", event, trace: metadata }).catch(() => {});
    }
    enqueue(report).then(sendResponse, error => {
        logger.error("音频播放失败。", error);
        sendResponse({ ok: false, error: String(error.message || error) });
    });
    return true; // Respond only after this sound ends (or fails), keeping the sender alive.
});
