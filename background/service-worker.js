import providers from "./providers/index.js";
import { createNotificationPlayer } from "./notification-player.js";
import { createLogger as createModuleLogger } from "../shared/logger.js";

const OFFSCREEN_DOC_PATH = "offscreen/offscreen.html";
const logger = createModuleLogger("ServiceWorker");

const audioLogger = createModuleLogger("ChatGPT");
const enqueueNotification = createNotificationPlayer(chrome, OFFSCREEN_DOC_PATH, {
    onEvent(event, trace) { audioLogger.debug(event, trace); },
});

function playNotification(providerName, trace = {}) {
    logger.info("通知已加入播放队列。", { provider: providerName });
    return enqueueNotification({ ...trace, provider: providerName });
}

function providerName(provider) {
    return provider.name ?? "未知提供者";
}

function registerRuntimeMessages() {
    const handlers = providers.filter((provider) => typeof provider.handleRuntimeMessage === "function");
    if (handlers.length === 0) {
        return;
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // Offscreen logs are mirrored here so manual diagnosis needs only two consoles.
        if (message?.type === "NOTIFICATION_DIAGNOSTIC"
            && sender.url === chrome.runtime.getURL(OFFSCREEN_DOC_PATH) && !sender.tab) {
            audioLogger.debug(message.event, message.trace);
            return;
        }
        for (const provider of handlers) {
            const result = provider.handleRuntimeMessage(message, sender, {
                playNotification: (trace) => playNotification(providerName(provider), trace),
                logger,
            });
            if (result && typeof result.then === "function") {
                result.then(() => sendResponse({ ok: true }), error => {
                    logger.error("通知处理失败。", error);
                    sendResponse({ ok: false });
                });
                return true;
            }
        }
        if (message?.type === "chatgpt_detector_ready") {
            sendResponse({ ok: true, tabId: sender.tab?.id ?? null });
        }
    });
}

registerRuntimeMessages();

logger.info("Service worker 已加载。", {
    version: chrome.runtime.getManifest().version,
    providers: providers.map((provider) => provider.name),
    time: new Date().toISOString(),
});
