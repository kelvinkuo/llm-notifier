// URL and method classification only. Hints are evidence; this module never decides COMPLETED.

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

export function classifyChatGPTRequest(url, method) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }

    if (!CHATGPT_HOSTS.has(parsed.hostname.toLowerCase())) {
        return null;
    }
    if (String(method || "").toUpperCase() !== "POST") {
        return null;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 0) {
        return null;
    }

    const last = segments[segments.length - 1].toLowerCase();
    const previous = segments.length > 1 ? segments[segments.length - 2].toLowerCase() : "";

    if (last === "conversation") {
        return "conversation";
    }
    if (last === "prepare" && previous === "conversation") {
        return "prepare";
    }
    if (last === "finalize") {
        return "finalize";
    }
    return null;
}

export function hintForChatGPTRequest(kind, phase, statusCode) {
    if (kind === "conversation" && phase === "start") {
        return "RESPONSE_REQUEST_STARTED";
    }
    if (kind === "conversation" && phase === "error") {
        return "RESPONSE_FAILED";
    }
    if (kind === "conversation" && phase === "end") {
        return statusCode === 200 ? "RESPONSE_STREAM_ENDED" : "RESPONSE_FAILED";
    }
    if (kind === "prepare" && phase === "end" && statusCode === 200) {
        return "PREPARE_SEEN";
    }
    if (kind === "finalize" && phase === "end" && statusCode === 200) {
        return "FINALIZE_SEEN";
    }
    return null;
}
