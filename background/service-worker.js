import providers from "./providers/index.js";
import { createLogger as createModuleLogger } from "../shared/logger.js";
import { registerChatGPTNetworkDiagnostics } from "./chatgpt-network-diagnostics.js";

const OFFSCREEN_DOC_PATH = "offscreen/offscreen.html";
const logger = createModuleLogger("ServiceWorker");

let creating;
async function setupOffscreenDocument(path) {
    logger.debug("正在检查是否已有 offscreen document。", {
        path,
        time: new Date().toISOString(),
    });
    const hasDocument = await chrome.offscreen.hasDocument();
    logger.debug("offscreen document 检查完成。", { hasDocument });

    if (hasDocument) {
        logger.debug("正在关闭旧 offscreen document。");
        await chrome.offscreen.closeDocument();
        logger.debug("旧 offscreen document 已关闭。");
    }
    if (creating) {
        logger.debug("offscreen document 正在由另一个调用创建，等待现有创建任务。");
        await creating;
        logger.debug("现有 offscreen document 创建任务已完成。");
        return;
    }

    logger.debug("开始创建新 offscreen document。", { path });
    try {
        creating = chrome.offscreen.createDocument({
            url: path,
            reasons: ["AUDIO_PLAYBACK"],
            justification: "To play a notification sound when LLM responds.",
        });
        await creating;
        logger.info("offscreen document 创建成功。", { path });
    } catch (error) {
        logger.error("offscreen document 创建失败。", error);
        throw error;
    } finally {
        creating = null;
    }
}

async function playNotification(providerName) {
    logger.info("playNotification 已调用。", {
        provider: providerName,
        time: new Date().toISOString(),
    });
    await setupOffscreenDocument(OFFSCREEN_DOC_PATH);
}

function createProviderLogger(providerName) {
    return createModuleLogger(`${providerName}Provider`);
}

function registerProvider(provider) {
    const { name, requestFilter, handleCompleted, extraInfoSpec } = provider;

    if (!requestFilter || !Array.isArray(requestFilter.urls) || requestFilter.urls.length === 0) {
        logger.error("Provider 缺少有效的 requestFilter.urls，已跳过注册。", {
            provider: name ?? "未知提供者",
        });
        return;
    }
    if (typeof handleCompleted !== "function") {
        logger.error("Provider 缺少 handleCompleted 实现，已跳过注册。", {
            provider: name ?? "未知提供者",
        });
        return;
    }

    const providerLogger = createProviderLogger(name ?? "未知提供者");

    const listener = async (details) => {
        try {
            await handleCompleted(details, {
                playNotification: () => playNotification(name ?? "未知提供者"),
                logger: providerLogger,
            });
        } catch (error) {
            providerLogger.error("处理请求时出现异常:", error);
        }
    };

    chrome.webRequest.onCompleted.addListener(listener, requestFilter, extraInfoSpec);
    providerLogger.info("Provider 已注册。", {
        requestFilter,
        extraInfoSpec: extraInfoSpec ?? [],
        time: new Date().toISOString(),
    });
}

providers.forEach(registerProvider);
registerChatGPTNetworkDiagnostics();

logger.info("Service worker 已加载。", {
    version: chrome.runtime.getManifest().version,
    providers: providers.map((provider) => provider.name),
    time: new Date().toISOString(),
});
