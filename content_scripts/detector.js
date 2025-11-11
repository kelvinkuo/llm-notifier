// content_scripts/detector.js

console.log("LLM 响应通知器：detector.js 已加载 (v3)！");

/**
 * 检查当前页面是否为 Gemini
 */
if (window.location.hostname.includes("gemini.google.com")) {
    console.log("检测到 Gemini 页面。正在启动观察器 (策略：mat-icon[fonticon=\"stop\"])");
    detectGemini();
}
// else if (window.location.hostname.includes("chat.openai.com") || window.location.hostname.includes("chatgpt.com")) {
//     console.log("检测到 ChatGPT 页面。");
//     // detectChatGPT();
// }


/**
 * 专用于检测 Gemini 响应的函数
 * (新策略：观察 <mat-icon fonticon="stop"> 的出现和消失)
 */
function detectGemini() {
    // 这是我们根据你的“审查元素”找到的、最精确的选择器！
    const GEMINI_STOP_ICON_SELECTOR = 'mat-icon[fonticon="stop"]';

    // 状态追踪变量
    let wasGenerating = false; 

    // 1. 创建一个 MutationObserver
    //    这个观察器将“监视” DOM 的变化
    const observer = new MutationObserver((mutationsList, obs) => {
        
        // 每次 DOM 变化时，我们都检查 "Stop" 图标现在是否存在
        const stopIcon = document.querySelector(GEMINI_STOP_ICON_SELECTOR);
        
        // 如果能找到 stopIcon (它不是 null)，说明正在生成
        const isGenerating = (stopIcon !== null); 

        // 核心逻辑：
        // 如果 *之前* 是在生成中 (wasGenerating = true)
        // 并且 *现在* 它 *不是* 在生成中 (isGenerating = false)
        // 这就意味着它 *刚刚* 完成了！
        if (wasGenerating && !isGenerating) {
            console.log("Gemini 响应完成！正在请求播放声音...");
            chrome.runtime.sendMessage({ action: "play_sound" });
        }

        // 更新“上一个”状态，为下一次 DOM 变化做准备
        wasGenerating = isGenerating;
    });

    // 2. 配置并启动观察器
    //    我们观察整个 document.body
    //    - childList: true (监视节点的添加/删除)
    //    - subtree: true (监视所有后代节点)
    //    这足以捕捉到 <mat-icon> 元素的出现和消失
    observer.observe(document.body, { 
        childList: true, 
        subtree: true 
    });

    console.log("Gemini 观察器已启动。");
}