// Only validate the sender and redact diagnostic URLs; no conversation tracking.

const CHATGPT_HOSTS = new Set([
    "chatgpt.com",
    "www.chatgpt.com",
    "chat.openai.com",
]);

export function isChatGPTPageUrl(url) {
    try {
        return CHATGPT_HOSTS.has(new URL(url).hostname.toLowerCase());
    } catch {
        return false;
    }
}

export function sanitizePageUrl(url) {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
}
