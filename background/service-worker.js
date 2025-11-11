// background/service-worker.js

// 监听来自 content_script (detector.js) 的消息
chrome.runtime.onMessage.addListener(async (message) => {
    if (message.action === "play_sound") {
        console.log("Service Worker 收到 play_sound 请求");
        await setupOffscreenDocument('offscreen/offscreen.html');
    }
});

let creating; // 状态锁，防止重复创建

/**
 * 创建或管理 Offscreen 文档
 * @param {string} path - offscreen.html 的路径
 */
async function setupOffscreenDocument(path) {
    // 检查是否已存在一个 offscreen document
    if (await chrome.offscreen.hasDocument()) {
        // 如果已存在，先关闭它，再创建新的
        // 这能确保声音总是从头开始播放（而不是多个声音重叠）
        await chrome.offscreen.closeDocument();
    }

    // 防止在创建过程中重复调用
    if (creating) {
        await creating;
        return;
    }

    // 创建 Offscreen 文档
    creating = chrome.offscreen.createDocument({
        url: path,
        reasons: ['AUDIO_PLAYBACK'], // 必须声明原因
        justification: 'To play a notification sound when LLM responds.'
    });

    try {
        await creating;
    } catch (error) {
        console.error("创建 Offscreen document 失败:", error);
    } finally {
        creating = null; // 释放锁
    }
}