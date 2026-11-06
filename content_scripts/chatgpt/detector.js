(function () {
    "use strict";

    // Exact labels/test ids observed on the supported Chinese/English layouts.
    const STOP = ["停止", "停止生成", "停止流式传输", "停止回答", "stop", "stop generating", "stop streaming", "stop response"];
    const SEND = ["发送", "发送提示", "发送消息", "send", "send prompt", "send message"];
    const VOICE = ["开始语音", "开启语音"];
    function visible(element, getStyle) {
        if (!element.isConnected || element.closest('[hidden], [aria-hidden="true"], [inert]')
            || !element.getClientRects().length) return false;
        const style = getStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
    }
    function classify(element) {
        const label = (element.getAttribute("aria-label") || "").trim().toLowerCase();
        const id = element.getAttribute("data-testid");
        const button = element.tagName === "BUTTON" || element.getAttribute("role") === "button";
        if (button && (id === "stop-button" || STOP.includes(label))) return "stop";
        if (button && (id === "send-button" || SEND.includes(label))) return "send";
        if (id === "composer-speech-button" || id === "composer-speech-button-container" || VOICE.includes(label)) return "voice";
        return null;
    }
    function read(doc, getStyle) {
        let idleSignal = null;
        for (const control of doc.querySelectorAll('button, [role="button"], a[aria-label]')) {
            if (!visible(control, getStyle)) continue;
            const signal = classify(control);
            if (signal === "stop") return { state: "ACTIVE", signal };
            if (signal) idleSignal = idleSignal || signal;
        }
        return idleSignal ? { state: "READY", signal: idleSignal } : { state: "UNKNOWN", signal: null };
    }
    globalThis.ChatGPTPageControls = { read };

    if (typeof document === "undefined" || typeof chrome === "undefined") return;
    const DEBUG = true;
    const diagnosticId = crypto.randomUUID();
    let tabId = null;
    let previousState = null;
    function debug(event, detail = {}) {
        if (!DEBUG) return;
        console.log("[LLM Notifier][ChatGPT]", event, JSON.stringify({
            time: new Date().toISOString(), diagnosticId, tabId, ...detail,
        }));
    }
    function failure(event, error, sequence) {
        console.error("[LLM Notifier][ChatGPT]", event, JSON.stringify({
            time: new Date().toISOString(), diagnosticId, tabId, sequence,
            error: String(error?.message || error).replace(/https?:\/\/[^\s]+/g, "[url]"),
        }));
    }
    function snapshot() {
        const view = read(document, element => getComputedStyle(element));
        if (view.state !== previousState) {
            previousState = view.state;
            debug("UI_STATE_CHANGED", view);
        }
        return view;
    }
    try {
        debug("CONTENT_SCRIPT_LOADED", { version: chrome.runtime.getManifest().version });
        const controller = ChatGPTCompletion.createController({
            read: snapshot,
            onDebug: debug,
            onCompleted(event) {
                debug("PLAY_SOUND_SENT", event);
                try {
                    chrome.runtime.sendMessage({ action: "play_sound", provider: "ChatGPT", ...event, diagnosticId, debug: DEBUG })
                        .then(result => {
                            if (!result?.ok) throw new Error("Notification playback was not acknowledged");
                            debug("PLAY_SOUND_ACK", { sequence: event.sequence });
                        }).catch(error => failure("PLAY_SOUND_FAILED", error, event.sequence));
                } catch (error) { failure("PLAY_SOUND_FAILED", error, event.sequence); }
            },
        });
        function sample() {
            try { controller.observe(snapshot()); }
            catch (error) { failure("DETECTION_FAILED", error); controller.observe({ state: "UNKNOWN" }); }
        }
        // One stable document observer; no binding to transient transcript/composer nodes.
        const observer = new MutationObserver(sample);
        observer.observe(document.documentElement, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ["aria-label", "data-testid", "disabled", "aria-disabled", "hidden", "aria-hidden", "inert", "class", "style"],
        });
        chrome.runtime.sendMessage({ type: "chatgpt_detector_ready", diagnosticId, debug: DEBUG, version: chrome.runtime.getManifest().version })
            .then(result => { tabId = result?.tabId ?? null; debug("DETECTOR_READY", { acknowledged: result?.ok === true }); })
            .catch(error => failure("READY_FAILED", error));
        sample();
    } catch (error) { failure("INIT_FAILED", error); }
})();
