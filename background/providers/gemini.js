const GEMINI_URL_PATTERN = "*://gemini.google.com/*/StreamGenerate*";

export function isGeminiStreamComplete(details) {
    return details.statusCode === 200 && details.method === "POST";
}

const geminiProvider = {
    name: "Gemini",
    requestFilter: {
        urls: [GEMINI_URL_PATTERN],
        types: ["xmlhttprequest"],
    },
    handleCompleted(details, { playNotification, logger }) {
        if (isGeminiStreamComplete(details)) {
            logger.info("响应完成。");
            playNotification();
        } else {
            logger.warn(`侦测到请求但状态码为 ${details.statusCode}`);
        }
    },
};

export default geminiProvider;

