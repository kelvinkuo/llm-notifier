import providers from "./providers/index.js";

const OFFSCREEN_DOC_PATH = "offscreen/offscreen.html";

let creating;
async function setupOffscreenDocument(path) {
    if (await chrome.offscreen.hasDocument()) {
        await chrome.offscreen.closeDocument();
    }
    if (creating) {
        await creating;
        return;
    }
    creating = chrome.offscreen.createDocument({
        url: path,
        reasons: ["AUDIO_PLAYBACK"],
        justification: "To play a notification sound when LLM responds.",
    });
    try {
        await creating;
    } catch (error) {
        console.error("创建 Offscreen document 失败:", error);
    } finally {
        creating = null;
    }
}

async function playNotification(providerName) {
    console.log(`${providerName} 响应完成，正在播放提示音…`);
    await setupOffscreenDocument(OFFSCREEN_DOC_PATH);
}

function createLogger(providerName) {
    return {
        info: (...args) => console.log(`[${providerName}]`, ...args),
        warn: (...args) => console.warn(`[${providerName}]`, ...args),
        error: (...args) => console.error(`[${providerName}]`, ...args),
    };
}

function registerProvider(provider) {
    const { name, requestFilter, handleCompleted, extraInfoSpec } = provider;

    if (!requestFilter || !Array.isArray(requestFilter.urls) || requestFilter.urls.length === 0) {
        console.error(`[${name ?? "未知提供者"}] 缺少有效的 requestFilter.urls，已跳过注册。`);
        return;
    }
    if (typeof handleCompleted !== "function") {
        console.error(`[${name ?? "未知提供者"}] 缺少 handleCompleted 实现，已跳过注册。`);
        return;
    }

    const logger = createLogger(name ?? "未知提供者");

    const listener = async (details) => {
        try {
            await handleCompleted(details, {
                playNotification: () => playNotification(name ?? "未知提供者"),
                logger,
            });
        } catch (error) {
            logger.error("处理请求时出现异常:", error);
        }
    };

    chrome.webRequest.onCompleted.addListener(listener, requestFilter, extraInfoSpec);
    logger.info(`正在监听 URL: ${requestFilter.urls.join(", ")}`);
}

providers.forEach(registerProvider);

console.log("Service Worker 已加载，已启用的模型：", providers.map((provider) => provider.name).join(", "));