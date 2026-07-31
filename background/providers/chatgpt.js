const CHATGPT_URL_PATTERNS = [
    "*://chat.openai.com/*conversation",
    "*://chatgpt.com/*conversation",
    "*://chatgpt.com/*conversation/prepare"
];

const PHASE_WAITING_FOR_POST_PREPARE = "waiting-for-post-prepare";
const completionStateByTab = new Map();

function getRequestKind(url) {
    try {
        const { pathname } = new URL(url);
        if (pathname === "/backend-api/f/conversation") {
            return "main-conversation";
        }
        if (pathname === "/backend-api/f/conversation/prepare") {
            return "conversation-prepare";
        }
    } catch {
        return "unknown";
    }
    return "other";
}

const chatgptProvider = {
    name: "ChatGPT",
    requestFilter: {
        urls: CHATGPT_URL_PATTERNS,
        types: ["xmlhttprequest"],
    },
    async handleCompleted(details, { playNotification, logger }) {
        logger.debug("收到 onCompleted 事件。", {
            url: details.url,
            method: details.method,
            statusCode: details.statusCode,
            type: details.type,
            tabId: details.tabId,
            requestId: details.requestId,
            timeStamp: details.timeStamp,
            ...(details.initiator ? { initiator: details.initiator } : {}),
        });

        const requestKind = getRequestKind(details.url);
        const currentState = completionStateByTab.get(details.tabId);

        if (
            requestKind === "main-conversation" &&
            details.statusCode === 200 &&
            details.method === "POST"
        ) {
            completionStateByTab.set(details.tabId, {
                phase: PHASE_WAITING_FOR_POST_PREPARE,
                mainRequestId: details.requestId,
            });
            logger.info("主 conversation 请求完成，等待后置 prepare。", {
                requestId: details.requestId,
                tabId: details.tabId,
            });
            return;
        }

        if (
            requestKind === "conversation-prepare" &&
            details.statusCode === 200 &&
            details.method === "POST"
        ) {
            if (currentState?.phase === PHASE_WAITING_FOR_POST_PREPARE) {
                completionStateByTab.delete(details.tabId);
                logger.info("检测到主请求后的 prepare，完成证据链成立，决定触发通知。", {
                    requestId: details.requestId,
                    tabId: details.tabId,
                    mainRequestId: currentState.mainRequestId,
                });
                await playNotification();
            } else {
                logger.debug("忽略非后置 prepare。", {
                    requestId: details.requestId,
                    tabId: details.tabId,
                    currentPhase: currentState?.phase ?? "idle",
                });
            }
            return;
        }

        const rejectionReasons = [];
        if (requestKind === "unknown" || requestKind === "other") {
            rejectionReasons.push(`不是完成证据链请求（类型为 ${requestKind}）`);
        }
        if (details.statusCode !== 200) {
            rejectionReasons.push(`statusCode 不是 200（实际为 ${details.statusCode}）`);
        }
        if (details.method !== "POST") {
            rejectionReasons.push(`method 不是 POST（实际为 ${details.method}）`);
        }
        logger.warn("请求不满足当前完成证据链条件，已忽略。", {
            requestId: details.requestId,
            tabId: details.tabId,
            requestKind,
            currentPhase: currentState?.phase ?? "idle",
            reasons: rejectionReasons,
        });
    },
};

export default chatgptProvider;
