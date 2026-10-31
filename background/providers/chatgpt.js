import { DEBUG } from "../../shared/logger.js";

import {
    classifyChatGPTRequest,
    hintForChatGPTRequest,
    isChatGPTPageUrl,
    sanitizePageUrl,
} from "./chatgpt-url.js";

const CHATGPT_NAVIGATION_URLS = [
    { hostEquals: "chatgpt.com" },
    { hostEquals: "www.chatgpt.com" },
    { hostEquals: "chat.openai.com" },
];

function chatGPTTrace(enabled, event, meta) {
    if (!enabled) return;
    console.log("[LLM Notifier][ChatGPT]", event, JSON.stringify({ time: new Date().toISOString(), ...meta }));
}

function sendTabMessage(tabId, payload) {
    return globalThis.chrome.tabs.sendMessage(tabId, payload);
}

export function handleChatGPTRuntimeMessage(message, sender, context) {
    const { playNotification, logger, offscreenPath } = context;

    if (message?.type === "chatgpt_detector_ready") {
        let page = "";
        try {
            page = sanitizePageUrl(sender.url || sender.tab?.url || "");
        } catch {
            page = "";
        }
        chatGPTTrace(DEBUG || Boolean(message.debug), "CHATGPT_DETECTOR_READY", {
            tabId: sender.tab?.id ?? null,
            page,
            version: message.version ?? null,
            diagnosticId: message.diagnosticId ?? null,
        });
        return;
    }

    if (message?.action !== "play_sound" || message.provider !== "ChatGPT") {
        return;
    }
    if (typeof sender.frameId === "number" && sender.frameId !== 0) {
        chatGPTTrace(DEBUG, "PLAY_SOUND_REJECTED", { reason: "non-top-frame", tabId: sender.tab?.id ?? null });
        return;
    }
    const pageUrl = sender.url || sender.tab?.url || "";
    if (!isChatGPTPageUrl(pageUrl)) {
        chatGPTTrace(DEBUG, "PLAY_SOUND_REJECTED", { reason: "unexpected-host", tabId: sender.tab?.id ?? null });
        logger.warn("忽略非 ChatGPT 页面的播放请求。");
        return;
    }

    let page = pageUrl;
    try {
        page = sanitizePageUrl(pageUrl);
    } catch {
        page = "";
    }
    const trace = {
        tabId: sender.tab?.id ?? null,
        page,
        reason: message.reason,
        sequence: message.sequence,
        messageId: message.messageId ?? null,
        diagnosticId: message.diagnosticId ?? null,
    };
    chatGPTTrace(DEBUG || Boolean(message.debug), "PLAY_SOUND_RECEIVED", trace);
    chatGPTTrace(DEBUG || Boolean(message.debug), "PLAY_NOTIFICATION_CALL", { provider: "ChatGPT" });
    chatGPTTrace(DEBUG || Boolean(message.debug), "OFFSCREEN_DISPATCH", { path: offscreenPath });
    logger.info("收到 ChatGPT 完成事件，准备播放提示音。", trace);
    playNotification(trace).catch((error) => {
        logger.error("播放 ChatGPT 通知失败。", error);
    });
}

export function forwardChatGPTRouteChange(details, sendMessage = sendTabMessage) {
    if (details.frameId !== 0) {
        return;
    }

    let url;
    try {
        url = sanitizePageUrl(details.url);
    } catch {
        return;
    }

    const delivery = sendMessage(details.tabId, {
        type: "CHATGPT_ROUTE_CHANGED",
        url,
    });
    if (delivery && typeof delivery.catch === "function") {
        delivery.catch(() => {});
    }
}

const CHATGPT_URL_PATTERNS = [
    "*://chat.openai.com/*conversation*",
    "*://chatgpt.com/*conversation*",
    "*://chat.openai.com/*finalize*",
    "*://chatgpt.com/*finalize*",
];

function pathnameOf(url) {
    try {
        return new URL(url).pathname;
    } catch {
        return null;
    }
}

function sendHint(tabId, hint, details, logger) {
    if (typeof tabId !== "number" || tabId < 0) {
        return;
    }

    const payload = {
        type: "CHATGPT_NETWORK_HINT",
        hint,
        requestId: details.requestId,
        statusCode: typeof details.statusCode === "number" ? details.statusCode : null,
    };

    try {
        const delivery = globalThis.chrome.tabs.sendMessage(tabId, payload);
        if (delivery && typeof delivery.catch === "function") {
            delivery.catch((error) => {
                logger.debug("网络 hint 未送达页面。", {
                    hint,
                    tabId,
                    pathname: pathnameOf(details.url),
                    message: error?.message || String(error),
                });
            });
        }
    } catch (error) {
        logger.debug("网络 hint 发送失败。", {
            hint,
            tabId,
            message: error?.message || String(error),
        });
    }
}

function forward(details, phase, logger) {
    const kind = classifyChatGPTRequest(details.url, details.method);
    if (!kind) {
        return;
    }

    const hint = hintForChatGPTRequest(kind, phase, details.statusCode);
    if (!hint) {
        return;
    }

    logger.debug("转发 ChatGPT 网络 hint。", {
        hint,
        kind,
        pathname: pathnameOf(details.url),
        method: details.method,
        statusCode: details.statusCode,
        tabId: details.tabId,
        requestId: details.requestId,
    });
    sendHint(details.tabId, hint, details, logger);
}

const chatgptProvider = {
    name: "ChatGPT",
    requestFilter: {
        urls: CHATGPT_URL_PATTERNS,
    },
    handleBeforeRequest(details, { logger }) {
        forward(details, "start", logger);
    },
    // Network completion is a hint for the content script. It does not play sound.
    handleCompleted(details, { logger }) {
        forward(details, "end", logger);
    },
    handleError(details, { logger }) {
        forward(details, "error", logger);
    },
    handleRuntimeMessage: handleChatGPTRuntimeMessage,
    navigation: {
        url: CHATGPT_NAVIGATION_URLS,
        onHistoryStateUpdated: forwardChatGPTRouteChange,
    },
};

export default chatgptProvider;
