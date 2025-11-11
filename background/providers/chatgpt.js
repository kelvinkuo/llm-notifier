const CHATGPT_URL_PATTERNS = [
    "*://chat.openai.com/*conversation",
    "*://chatgpt.com/*conversation"
];

const chatgptProvider = {
    name: "ChatGPT",
    requestFilter: {
        urls: CHATGPT_URL_PATTERNS,
        types: ["xmlhttprequest"],
    },
    handleCompleted(details, { playNotification, logger }) {
        if (details.statusCode === 200 && details.method === "POST") {
            logger.info("响应完成。");
            playNotification();
        } else {
            logger.warn(`侦测到请求但状态码为 ${details.statusCode}`);
        }
    },
};

export default chatgptProvider;

