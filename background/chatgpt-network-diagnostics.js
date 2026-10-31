// Diagnostics only. Logs ChatGPT XHR timing when DEBUG is enabled.
// This module does not classify requests and does not decide completion.

import { classifyChatGPTRequest } from "./providers/chatgpt-url.js";
import { DEBUG, createLogger } from "../shared/logger.js";

const logger = createLogger("ChatGPTNetwork");
const requestStartTimes = new Map();
const requestFilter = {
    urls: ["https://chatgpt.com/*"],
    types: ["xmlhttprequest"],
};

function sanitizeUrl(url) {
    try {
        const parsedUrl = new URL(url);
        return `${parsedUrl.origin}${parsedUrl.pathname}`;
    } catch {
        return null;
    }
}


function createRequestLog(details) {
    return {
        url: sanitizeUrl(details.url),
        method: details.method,
        type: details.type,
        tabId: details.tabId,
        requestId: details.requestId,
        timeStamp: details.timeStamp,
        time: new Date(details.timeStamp).toISOString(),
        ...(details.initiator ? { initiator: sanitizeUrl(details.initiator) } : {}),
    };
}

export function registerChatGPTNetworkDiagnostics() {
    if (!DEBUG) {
        return;
    }

    chrome.webRequest.onBeforeRequest.addListener((details) => {
        if (!classifyChatGPTRequest(details.url, details.method)) return;
        requestStartTimes.set(details.requestId, details.timeStamp);
        logger.debug("请求开始。", createRequestLog(details));
    }, requestFilter);

    chrome.webRequest.onCompleted.addListener((details) => {
        if (!classifyChatGPTRequest(details.url, details.method)) return;
        const startTime = requestStartTimes.get(details.requestId);
        requestStartTimes.delete(details.requestId);

        logger.debug("请求完成。", {
            ...createRequestLog(details),
            statusCode: details.statusCode,
            durationMs: startTime === undefined
                ? null
                : Math.round((details.timeStamp - startTime) * 100) / 100,
            missingStartEvent: startTime === undefined,
        });
    }, requestFilter);

    chrome.webRequest.onErrorOccurred.addListener((details) => {
        if (!classifyChatGPTRequest(details.url, details.method)) return;
        const startTime = requestStartTimes.get(details.requestId);
        requestStartTimes.delete(details.requestId);

        logger.warn("请求失败。", {
            ...createRequestLog(details),
            error: details.error,
            durationMs: startTime === undefined
                ? null
                : Math.round((details.timeStamp - startTime) * 100) / 100,
            missingStartEvent: startTime === undefined,
        });
    }, requestFilter);

    logger.info("ChatGPT 网络时间线诊断已启用。", {
        requestFilter,
        queryAndHashRemoved: true,
        time: new Date().toISOString(),
    });
}
