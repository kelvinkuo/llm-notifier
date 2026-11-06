import { DEBUG } from "../../shared/logger.js";

import {
    isChatGPTPageUrl,
    sanitizePageUrl,
} from "./chatgpt-url.js";

function chatGPTTrace(enabled, event, meta) {
    if (!enabled) return;
    console.log("[LLM Notifier][ChatGPT]", event, JSON.stringify({ time: new Date().toISOString(), ...meta }));
}

export function handleChatGPTRuntimeMessage(message, sender, context) {
    const { playNotification, logger } = context;

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
        diagnosticId: message.diagnosticId ?? null,
    };
    chatGPTTrace(DEBUG || Boolean(message.debug), "PLAY_SOUND_RECEIVED", trace);
    logger.info("收到 ChatGPT 完成事件，准备播放提示音。", trace);
    return playNotification(trace);
}

export default { name: "ChatGPT", handleRuntimeMessage: handleChatGPTRuntimeMessage };
