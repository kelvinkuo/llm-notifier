// background/service-worker.js (V3.3 - 最终修复版)

// ------------------------------------------
// 1. 声音播放逻辑 (不变)
// ------------------------------------------

let creating; // 状态锁
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
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'To play a notification sound when LLM responds.'
    });
    try {
        await creating;
    } catch (error) {
        console.error("创建 Offscreen document 失败:", error);
    } finally {
        creating = null;
    }
}

// ------------------------------------------
// 2. 新的网络请求侦测逻辑 (V3.3)
// ------------------------------------------

/**
 * 我们要监听的 URL 模式。
 */
const GEMINI_URL_PATTERN = "*://gemini.google.com/*/StreamGenerate*";

// 监听 "onCompleted" 事件
chrome.webRequest.onCompleted.addListener(
    (details) => {
        // 确保请求是成功的
        if (details.statusCode === 200) {
            console.log("Gemini 响应完成 (V3.3)！正在播放声音...");
            setupOffscreenDocument('offscreen/offscreen.html');
        } else {
            console.warn(`侦测到 StreamGenerate，但状态码为: ${details.statusCode}`);
        }
    },
    {
        // 过滤条件：只监听我们感兴趣的 URL
        urls: [GEMINI_URL_PATTERN],
        // 过滤条件：只监听 XHR
        types: ["xmlhttprequest"] 
    }
);

console.log("Service Worker (V3.3 - 最终修复版) 已加载。");
console.log(`正在监听: ${GEMINI_URL_PATTERN}`);