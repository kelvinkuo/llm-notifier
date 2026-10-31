import providers from "./providers/index.js";
import { createNotificationPlayer } from "./notification-player.js";
import { createLogger as createModuleLogger } from "../shared/logger.js";
import { registerChatGPTNetworkDiagnostics } from "./chatgpt-network-diagnostics.js";

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

function createProviderLogger(providerName) {
    return createModuleLogger(`${providerName}Provider`);
}

function providerName(provider) {
    return provider.name ?? "未知提供者";
}

function registerWebRequest(provider) {
    const { requestFilter, handleCompleted, extraInfoSpec } = provider;
    if (!requestFilter) {
        return;
    }

    if (!Array.isArray(requestFilter.urls) || requestFilter.urls.length === 0) {
        logger.error("Provider 缺少有效的 requestFilter.urls，已跳过注册。", {
            provider: providerName(provider),
        });
        return;
    }
    if (typeof handleCompleted !== "function") {
        logger.error("Provider 缺少 handleCompleted 实现，已跳过注册。", {
            provider: providerName(provider),
        });
        return;
    }

    const providerLogger = createProviderLogger(providerName(provider));
    const context = {
        playNotification: () => playNotification(providerName(provider)),
        logger: providerLogger,
    };

    const listener = async (details) => {
        try {
            await handleCompleted(details, context);
        } catch (error) {
            providerLogger.error("处理请求时出现异常:", error);
        }
    };

    chrome.webRequest.onCompleted.addListener(listener, requestFilter, extraInfoSpec);
    registerOptionalListener("onBeforeRequest", provider.handleBeforeRequest, requestFilter, providerLogger);
    registerOptionalListener("onErrorOccurred", provider.handleError, requestFilter, providerLogger);
    providerLogger.info("Provider 已注册。", {
        requestFilter,
        extraInfoSpec: extraInfoSpec ?? [],
        time: new Date().toISOString(),
    });
}

function registerOptionalListener(eventName, handler, requestFilter, providerLogger) {
    if (typeof handler !== "function") {
        return;
    }

    const listener = (details) => {
        try {
            handler(details, { logger: providerLogger });
        } catch (error) {
            providerLogger.error("处理请求时出现异常:", error);
        }
    };

    chrome.webRequest[eventName].addListener(listener, requestFilter);
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
                offscreenPath: OFFSCREEN_DOC_PATH,
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

function registerNavigation(provider) {
    const navigation = provider.navigation;
    if (!navigation || typeof navigation.onHistoryStateUpdated !== "function") {
        return;
    }

    try {
        chrome.webNavigation.onHistoryStateUpdated.addListener(
            (details) => navigation.onHistoryStateUpdated(details),
            { url: navigation.url },
        );
    } catch (error) {
        logger.error(`${providerName(provider)} 路由监听注册失败。`, error);
    }
}

registerRuntimeMessages();
providers.forEach(registerWebRequest);
registerChatGPTNetworkDiagnostics();
providers.forEach(registerNavigation);

logger.info("Service worker 已加载。", {
    version: chrome.runtime.getManifest().version,
    providers: providers.map((provider) => provider.name),
    time: new Date().toISOString(),
});
