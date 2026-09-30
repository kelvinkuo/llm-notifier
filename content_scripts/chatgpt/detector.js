(function () {
    "use strict";

    // data-message-author-role is a legacy fallback selector, not a required match.
    const USER_SELECTORS = [
        "[data-content-search-unit-key$=':user']",
        "[data-chatgpt-search-unit-key$=':user']",
        "[data-user-message-bubble='true']",
        "[data-message-author-role='user']",
    ];
    const ASSISTANT_SELECTORS = [
        "[data-content-search-unit-key$=':assistant']",
        "[data-chatgpt-search-unit-key$=':assistant']",
        "[data-markdown-text-style='assistant-message']",
        "[data-message-author-role='assistant']",
    ];
    const CONVERSATION_ROOTS = [
        { selector: "[data-thread-find-target='conversation']", rank: 3 },
        { selector: "[data-chatgpt-conversation-selection-target='true']", rank: 2 },
        { selector: "main", rank: 1 },
    ];

    const domIds = new WeakMap();
    let domSerial = 0;

    function closestMatching(element, selectors) {
        if (!element || !element.closest) return null;
        for (let i = 0; i < selectors.length; i += 1) {
            const match = element.closest(selectors[i]);
            if (match) return match;
        }
        return null;
    }

    function canonicalUser(element) {
        return closestMatching(element, USER_SELECTORS);
    }

    function canonicalAssistant(element) {
        return closestMatching(element, ASSISTANT_SELECTORS);
    }

    function collectMessages(root, selectors, canonicalize) {
        if (!root || !root.querySelectorAll) return [];
        const found = [];
        const seen = new Set();
        function add(node) {
            if (!node || node.nodeType === 3) return;
            const canonical = canonicalize(node);
            if (!canonical || seen.has(canonical)) return;
            if (root.contains && canonical !== root && !root.contains(canonical)) return;
            seen.add(canonical);
            found.push(canonical);
        }
        if (root.matches) {
            for (let i = 0; i < selectors.length; i += 1) {
                if (root.matches(selectors[i])) {
                    add(root);
                    break;
                }
            }
        }
        for (let i = 0; i < selectors.length; i += 1) {
            const nodes = root.querySelectorAll(selectors[i]);
            for (let j = 0; j < nodes.length; j += 1) add(nodes[j]);
        }
        return found;
    }

    function findUserMessages(root) {
        return collectMessages(root, USER_SELECTORS, canonicalUser);
    }

    function findAssistantMessages(root) {
        return collectMessages(root, ASSISTANT_SELECTORS, canonicalAssistant);
    }

    function readAttr(element, name) {
        if (!element) return null;
        if (element.getAttribute) {
            const own = element.getAttribute(name);
            if (own) return own;
        }
        if (element.querySelector) {
            const child = element.querySelector("[" + name + "]");
            if (child && child.getAttribute) {
                const value = child.getAttribute(name);
                if (value) return value;
            }
        }
        const parent = element.parentElement;
        if (parent && parent.closest) {
            const ancestor = parent.closest("[" + name + "]");
            if (ancestor && ancestor.getAttribute) {
                const value = ancestor.getAttribute(name);
                if (value) return value;
            }
        }
        return null;
    }

    function normalizeMessageIds(value) {
        const parts = String(value).trim().split(/\s+/);
        const seen = new Set();
        const unique = [];
        for (let i = 0; i < parts.length; i += 1) {
            const part = parts[i];
            if (!part || seen.has(part)) continue;
            seen.add(part);
            unique.push(part);
        }
        return unique.join(" ");
    }

    function messageIdentity(element) {
        if (!element) return null;
        const selectionId = readAttr(element, "data-chatgpt-selection-message-id");
        if (selectionId) return selectionId;
        const searchIds = readAttr(element, "data-chatgpt-search-message-ids");
        if (searchIds) return normalizeMessageIds(searchIds);
        const contentKey = readAttr(element, "data-content-search-unit-key");
        if (contentKey) return contentKey;
        const searchKey = readAttr(element, "data-chatgpt-search-unit-key");
        if (searchKey) return searchKey;
        const turnKey = readAttr(element, "data-turn-key");
        if (turnKey) return turnKey;
        const legacyId = readAttr(element, "data-message-id") || readAttr(element, "data-turn-id");
        if (legacyId) return legacyId;
        if (!domIds.has(element)) {
            domSerial += 1;
            domIds.set(element, "dom-" + domSerial);
        }
        return domIds.get(element);
    }

    function messageIds(elements) {
        const ids = [];
        const seen = new Set();
        for (let i = 0; i < elements.length; i += 1) {
            const id = messageIdentity(elements[i]);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            ids.push(id);
        }
        return ids;
    }

    function describeRoot(root) {
        if (!root || !root.matches) return null;
        for (let i = 0; i < CONVERSATION_ROOTS.length; i += 1) {
            if (root.matches(CONVERSATION_ROOTS[i].selector)) return CONVERSATION_ROOTS[i].selector;
        }
        return root.tagName ? root.tagName.toLowerCase() : null;
    }

    function rootRank(root) {
        const selector = describeRoot(root);
        for (let i = 0; i < CONVERSATION_ROOTS.length; i += 1) {
            if (CONVERSATION_ROOTS[i].selector === selector) return CONVERSATION_ROOTS[i].rank;
        }
        return 0;
    }

    function findConversationRoot(doc) {
        const scope = doc || null;
        if (!scope || !scope.querySelector) return { element: null, selector: null };
        for (let i = 0; i < CONVERSATION_ROOTS.length; i += 1) {
            const element = scope.querySelector(CONVERSATION_ROOTS[i].selector);
            if (element) return { element: element, selector: CONVERSATION_ROOTS[i].selector };
        }
        return { element: null, selector: null };
    }

    function findComposer(doc, root) {
        const scope = doc || null;
        const prompt = scope && scope.getElementById ? scope.getElementById("prompt-textarea") : null;
        if (prompt) return prompt.closest("form") || prompt;
        const editable = scope && scope.querySelector ? scope.querySelector("[contenteditable='true']") : null;
        if (editable) return editable.closest("form") || editable;
        if (root && root.querySelector) {
            const form = root.querySelector("form");
            if (form) return form;
        }
        return null;
    }

    const COMPOSER_LANDMARKS = [
        "[data-composer-layout]",
        "[data-composer-body]",
        "[data-composer-footer-responsive]",
    ];
    const COMPOSER_STATE = {
        READY_EMPTY: "READY_EMPTY",
        READY_DRAFT: "READY_DRAFT",
        ACTIVE: "ACTIVE",
        UNKNOWN: "UNKNOWN",
    };
    // Locale aliases are exact accessible names. Add a verified label here; do not infer idle from button type.
    const STOP_LABELS = ["停止", "停止生成", "停止流式传输", "停止回答", "stop", "stop generating", "stop streaming", "stop response"];
    const SEND_LABELS = ["发送", "发送提示", "发送消息", "send", "send prompt", "send message"];
    const VOICE_IDLE_LABELS = ["开始语音"];

    function controlLabel(element) {
        if (!element || !element.getAttribute) return "";
        const label = element.getAttribute("aria-label");
        return label && label.trim() ? label.trim() : "";
    }

    function isButtonLike(element) {
        if (!element || !element.getAttribute) return false;
        if (element.tagName === "BUTTON") return true;
        return element.getAttribute("role") === "button";
    }

    function isComposerLandmark(node) {
        if (!node || !node.matches) return false;
        for (let i = 0; i < COMPOSER_LANDMARKS.length; i += 1) {
            if (node.matches(COMPOSER_LANDMARKS[i])) return true;
        }
        return false;
    }

    function isPageShell(node) {
        if (!node || !node.tagName) return true;
        const tag = node.tagName;
        return tag === "BODY" || tag === "HTML" || tag === "HEAD";
    }

    function matchesLabel(label, aliases) {
        if (!label) return false;
        const normalized = label.trim().toLowerCase();
        for (let i = 0; i < aliases.length; i += 1) {
            if (aliases[i].toLowerCase() === normalized) return true;
        }
        return false;
    }

    function controlType(element) {
        if (!element || !element.getAttribute) return null;
        const type = element.getAttribute("type");
        return type && String(type).trim() ? String(type).trim() : null;
    }

    function isStopControl(element) {
        if (!isButtonLike(element)) return false;
        const testId = element.getAttribute("data-testid") || "";
        if (testId === "stop-button") return true;
        return matchesLabel(controlLabel(element), STOP_LABELS);
    }

    function isPrimarySendControl(element) {
        if (!isButtonLike(element)) return false;
        const testId = element.getAttribute("data-testid") || "";
        if (testId === "send-button") return true;
        return matchesLabel(controlLabel(element), SEND_LABELS);
    }

    function isVoiceIdleControl(element) {
        if (!isButtonLike(element)) return false;
        const testId = element.getAttribute("data-testid") || "";
        if (testId === "composer-speech-button" || testId === "composer-speech-button-container") return true;
        return matchesLabel(controlLabel(element), VOICE_IDLE_LABELS);
    }

    function classifyControl(element) {
        if (isStopControl(element)) return COMPOSER_STATE.ACTIVE;
        if (isPrimarySendControl(element)) return COMPOSER_STATE.READY_DRAFT;
        if (isVoiceIdleControl(element)) return COMPOSER_STATE.READY_EMPTY;
        return null;
    }

    function containsPrimaryControl(node) {
        if (!node || !node.querySelectorAll) return false;
        const controls = node.querySelectorAll("button, [role='button']");
        for (let i = 0; i < controls.length; i += 1) {
            if (classifyControl(controls[i])) return true;
        }
        return false;
    }

    function findEditable(scope) {
        if (!scope) return null;
        if (scope.getElementById) {
            const prompt = scope.getElementById("prompt-textarea");
            if (prompt) return prompt;
        }
        if (scope.querySelector) return scope.querySelector("[contenteditable='true']");
        return null;
    }

    function findComposerRoot(doc, conversationRoot) {
        const scope = doc && (doc.querySelector || doc.getElementById) ? doc : conversationRoot;
        if (!scope) return null;
        const editable = findEditable(scope);
        if (!editable) {
            if (!scope.querySelector) return null;
            for (let i = 0; i < COMPOSER_LANDMARKS.length; i += 1) {
                const landmark = scope.querySelector(COMPOSER_LANDMARKS[i]);
                if (landmark) return landmark;
            }
            return null;
        }

        let landmarkWithControls = null;
        let nearestLandmark = null;
        let controlHost = null;
        let node = editable;
        while (node && node.nodeType === 1 && !isPageShell(node)) {
            const landmark = isComposerLandmark(node);
            if (landmark && !nearestLandmark) nearestLandmark = node;
            if (node !== editable && containsPrimaryControl(node)) {
                if (landmark) {
                    landmarkWithControls = node;
                    break;
                }
                if (!controlHost) controlHost = node;
            }
            node = node.parentElement;
        }
        if (landmarkWithControls) return landmarkWithControls;
        if (controlHost) return controlHost;
        if (nearestLandmark) return nearestLandmark;
        if (editable.closest) {
            const form = editable.closest("form");
            if (form) return form;
        }
        return null;
    }

    function emptyComposerObservation() {
        return {
            state: COMPOSER_STATE.UNKNOWN,
            primaryLabel: null,
            primaryType: null,
        };
    }

    function readComposer(doc, conversationRoot) {
        const root = findComposerRoot(doc, conversationRoot);
        if (!root || !root.querySelectorAll) return emptyComposerObservation();
        const controls = root.querySelectorAll("button, [role='button']");
        let active = null;
        let draft = null;
        let empty = null;
        for (let i = 0; i < controls.length; i += 1) {
            const control = controls[i];
            const state = classifyControl(control);
            const described = {
                state: state,
                primaryLabel: controlLabel(control) || null,
                primaryType: controlType(control),
            };
            if (state === COMPOSER_STATE.ACTIVE && !active) active = described;
            else if (state === COMPOSER_STATE.READY_DRAFT && !draft) draft = described;
            else if (state === COMPOSER_STATE.READY_EMPTY && !empty) empty = described;
        }
        return active || draft || empty || emptyComposerObservation();
    }

    function getComposerState(doc, conversationRoot) {
        return readComposer(doc, conversationRoot).state;
    }

    function elementNode(node) {
        if (!node) return null;
        if (node.nodeType === 3) return node.parentElement || null;
        return node;
    }

    function mutationTouchesElement(mutation, element) {
        if (!element || !element.contains) return false;
        const target = elementNode(mutation.target);
        if (!target) return false;
        return target === element || element.contains(target);
    }

    function nodeContainsMessage(node) {
        const element = elementNode(node);
        if (!element || element.nodeType === 3) return false;
        if (element.matches) {
            for (let i = 0; i < USER_SELECTORS.length; i += 1) {
                if (element.matches(USER_SELECTORS[i])) return true;
            }
            for (let i = 0; i < ASSISTANT_SELECTORS.length; i += 1) {
                if (element.matches(ASSISTANT_SELECTORS[i])) return true;
            }
        }
        if (!element.querySelector) return false;
        for (let i = 0; i < USER_SELECTORS.length; i += 1) {
            if (element.querySelector(USER_SELECTORS[i])) return true;
        }
        for (let i = 0; i < ASSISTANT_SELECTORS.length; i += 1) {
            if (element.querySelector(ASSISTANT_SELECTORS[i])) return true;
        }
        return false;
    }

    function mutationAddsMessage(mutation) {
        if (!mutation || mutation.type !== "childList") return false;
        const groups = [mutation.addedNodes, mutation.removedNodes];
        for (let g = 0; g < groups.length; g += 1) {
            const nodes = groups[g];
            if (!nodes) continue;
            for (let i = 0; i < nodes.length; i += 1) {
                if (nodeContainsMessage(nodes[i])) return true;
            }
        }
        return false;
    }

    globalThis.ChatGPTMessageAdapter = {
        findUserMessages: findUserMessages,
        findAssistantMessages: findAssistantMessages,
        messageIdentity: messageIdentity,
        messageIds: messageIds,
        canonicalUser: canonicalUser,
        canonicalAssistant: canonicalAssistant,
        describeRoot: describeRoot,
        rootRank: rootRank,
        findConversationRoot: findConversationRoot,
        findComposer: findComposer,
        mutationTouchesElement: mutationTouchesElement,
        mutationAddsMessage: mutationAddsMessage,
    };

    const composerApi = {
        findComposerRoot: findComposerRoot,
        readComposer: readComposer,
        getComposerState: getComposerState,
        readState: getComposerState,
        isStopControl: isStopControl,
        isPrimarySendControl: isPrimarySendControl,
        isVoiceIdleControl: isVoiceIdleControl,
    };
    globalThis.ChatGPTComposerAdapter = composerApi;
    globalThis.ChatGPTComposer = composerApi;
})();

(function () {
    "use strict";

    if (typeof location === "undefined" || typeof document === "undefined" || typeof chrome === "undefined") {
        return;
    }

    const CHATGPT_DEBUG = false;
    const CHATGPT_DETECTOR_VERSION = "1.5.1";
    const PREFIX = "[AI Completion][ChatGPT]";
    const SNAPSHOT_MS = 50;
    const messages = globalThis.ChatGPTMessageAdapter;

    function fail(error) {
        const detail = error && error.stack ? error.stack : String(error);
        console.error(PREFIX, "INIT_FAILED", detail);
    }

    try {
        if (CHATGPT_DEBUG) {
            console.log(PREFIX, "BOOT", {
                version: CHATGPT_DETECTOR_VERSION,
                href: location.href,
                readyState: document.readyState,
            });
        }
    } catch (error) {
        fail(error);
    }

    try {
        if (!globalThis.ChatGPTCompletion) {
            fail("ChatGPTCompletion is missing");
            return;
        }
        const started = startDetector();
        if (started && typeof started.catch === "function") {
            started.catch(fail);
        }
    } catch (error) {
        fail(error);
    }

    function startDetector() {
        const host = location.hostname;
        if (host !== "chatgpt.com" && host !== "www.chatgpt.com" && host !== "chat.openai.com") {
            fail("unexpected host: " + host);
            return;
        }

        const {
            createChatGPTCompletionController,
            createPlaySoundMessage,
            createRootWatcher,
            conversationKeyFromUrl,
        } = globalThis.ChatGPTCompletion;

        function debug(event, meta) {
            if (!CHATGPT_DEBUG) return;
            if (meta === undefined) console.log(PREFIX, event);
            else console.log(PREFIX, event, meta);
        }

        let boundRoot = null;
        let boundRootSelector = null;
        let previousSignature = null;
        let snapshotTimer = null;
        let conversationObserver = null;
        let composerObserver = null;
        let boundComposer = null;
        let lastObservedComposerState = null;
        let baselineAssistantIds = new Set();
        let trackedAssistantId = null;
        let trackedAssistantElement = null;

        function postToWorker(payload, failureEvent) {
            try {
                const delivery = chrome.runtime.sendMessage(payload);
                if (delivery && typeof delivery.catch === "function") {
                    delivery.catch(function (error) {
                        const detail = error && error.message ? error.message : error;
                        console.error(PREFIX, failureEvent, detail);
                        if (failureEvent === "READY_FAILED") fail(error);
                    });
                }
            } catch (error) {
                console.error(PREFIX, failureEvent, error && error.stack ? error.stack : error);
                if (failureEvent === "READY_FAILED") fail(error);
            }
        }

        const controller = createChatGPTCompletionController({
            onCompleted: function (event) {
                const payload = createPlaySoundMessage(event);
                payload.debug = CHATGPT_DEBUG;
                debug("PLAY_SOUND_SEND", {
                    sequence: payload.sequence,
                    messageId: payload.messageId,
                    reason: payload.reason,
                });
                postToWorker(payload, "PLAY_SOUND_SEND_FAILED");
            },
            onDebug: debug,
        });

        postToWorker({
            type: "chatgpt_detector_ready",
            version: CHATGPT_DETECTOR_VERSION,
            debug: CHATGPT_DEBUG,
        }, "READY_FAILED");

        function accessibleName(element) {
            const label = element.getAttribute("aria-label");
            if (label && label.trim()) return label.trim();
            const text = (element.textContent || "").replace(/\s+/g, " ").trim();
            return text.length > 80 ? text.slice(0, 80) : text;
        }

        function isStopControl(element) {
            const adapter = globalThis.ChatGPTComposerAdapter;
            return Boolean(adapter && adapter.isStopControl && adapter.isStopControl(element));
        }

        function isSendControl(element) {
            const adapter = globalThis.ChatGPTComposerAdapter;
            return Boolean(adapter && adapter.isPrimarySendControl && adapter.isPrimarySendControl(element));
        }

        function isRegenerateControl(element) {
            if (!element) return false;
            const testId = element.getAttribute("data-testid") || "";
            if (testId === "regenerate-thread-button" || testId === "regenerate-button") return true;
            return /^(regenerate|retry|try again|重新生成|重试)$/i.test(accessibleName(element));
        }

        function findComposer(root) {
            const adapter = globalThis.ChatGPTComposerAdapter;
            if (adapter && typeof adapter.findComposerRoot === "function") {
                return adapter.findComposerRoot(document, root || boundRoot);
            }
            return messages.findComposer(document, root || boundRoot);
        }

        function queryPreferredRoot() {
            return messages.findConversationRoot(document).element;
        }

        function readComposerObservation(root) {
            const adapter = globalThis.ChatGPTComposerAdapter;
            if (!adapter || typeof adapter.readComposer !== "function") {
                return { state: "UNKNOWN", primaryLabel: null, primaryType: null };
            }
            const observation = adapter.readComposer(document, root || boundRoot) || {};
            const state = observation.state;
            if (state === "READY_EMPTY" || state === "READY_DRAFT" || state === "ACTIVE" || state === "UNKNOWN") {
                return {
                    state: state,
                    primaryLabel: observation.primaryLabel || null,
                    primaryType: observation.primaryType || null,
                };
            }
            return { state: "UNKNOWN", primaryLabel: null, primaryType: null };
        }

        function findTurnRoot(assistant) {
            if (!assistant) return null;
            const turn = assistant.closest("[data-turn-key], [data-turn-id], [data-testid^='conversation-turn-']");
            return turn || assistant;
        }

        function measureAssistant(assistant) {
            if (!assistant) return 0;
            const textLength = assistant.textContent ? assistant.textContent.length : 0;
            return (assistant.childElementCount * 1000003) + textLength;
        }

        function hasContinueOffer(turn) {
            if (!turn) return false;
            const controls = turn.querySelectorAll("button, [role='button']");
            for (let i = 0; i < controls.length; i += 1) {
                if (/^(continue generating|继续生成)$/i.test(accessibleName(controls[i]))) return true;
            }
            return false;
        }

        function isTurnBusy(turn) {
            if (!turn) return false;
            if (turn.getAttribute("aria-busy") === "true") return true;
            return Boolean(turn.querySelector("[aria-busy='true']"));
        }

        function readModel(root) {
            const users = messages.findUserMessages(root);
            const assistants = messages.findAssistantMessages(root);
            const userMessageIds = messages.messageIds(users);
            const assistantMessageIds = messages.messageIds(assistants);
            const latest = assistants.length ? assistants[assistants.length - 1] : null;
            const latestId = assistantMessageIds.length ? assistantMessageIds[assistantMessageIds.length - 1] : null;
            let rebound = false;
            if (latest && latestId && (!baselineAssistantIds.has(latestId) || latestId === trackedAssistantId)) {
                rebound = Boolean(trackedAssistantElement && trackedAssistantId === latestId && trackedAssistantElement !== latest);
                trackedAssistantId = latestId;
                trackedAssistantElement = latest;
            }
            const focus = trackedAssistantElement && trackedAssistantElement.isConnected !== false
                ? trackedAssistantElement
                : latest;
            const turn = findTurnRoot(focus);
            const composer = readComposerObservation(root);
            const stopControl = composer.state === "ACTIVE";
            return {
                userMessageIds: userMessageIds,
                assistantMessageIds: assistantMessageIds,
                assistantSize: measureAssistant(focus),
                assistantRebound: rebound,
                stopControl: stopControl,
                composerState: composer.state,
                composerPrimaryLabel: composer.primaryLabel,
                composerPrimaryType: composer.primaryType,
                continueOffered: !stopControl && hasContinueOffer(turn),
                activityBlocked: isTurnBusy(turn),
                conversationKey: conversationKeyFromUrl(location.href),
                rootTag: root.tagName || "MAIN",
                rootSelector: boundRootSelector || messages.describeRoot(root),
                composerFound: Boolean(findComposer(root)),
            };
        }

        function rememberSignature(model) {
            previousSignature = {
                assistantKey: model.assistantMessageIds.join("|"),
                assistantSize: model.assistantSize,
            };
        }

        function publish() {
            try {
                if (!boundRoot || boundRoot.isConnected === false) {
                    rootWatcher.checkConnection();
                    return;
                }
                syncComposerObserver();
                if (upgradeRootIfNeeded()) {
                    // The upgraded root is read on this same snapshot.
                }
                if (location.pathname !== lastPathname) {
                    lastPathname = location.pathname;
                    previousSignature = null;
                    controller.noteRouteChange(location.href);
                    if (controller.getState().phase === "IDLE") {
                        const baseline = readModel(boundRoot);
                        rememberSignature(baseline);
                        controller.noteBaseline(baseline);
                    }
                }
                const model = readModel(boundRoot);
                const assistantChanged = Boolean(previousSignature && (
                    previousSignature.assistantKey !== model.assistantMessageIds.join("|")
                    || previousSignature.assistantSize !== model.assistantSize
                    || model.assistantRebound
                ));
                rememberSignature(model);
                controller.noteDom({
                    userMessageIds: model.userMessageIds,
                    assistantMessageIds: model.assistantMessageIds,
                    assistantChanged: assistantChanged,
                    stopControl: model.stopControl,
                    composerState: model.composerState,
                    composerPrimaryLabel: model.composerPrimaryLabel,
                    composerPrimaryType: model.composerPrimaryType,
                    continueOffered: model.continueOffered,
                    activityBlocked: model.activityBlocked,
                    conversationKey: model.conversationKey,
                });
            } catch (error) {
                fail(error);
            }
        }

        function scheduleSnapshot() {
            if (snapshotTimer !== null) return;
            snapshotTimer = setTimeout(function () {
                snapshotTimer = null;
                publish();
            }, SNAPSHOT_MS);
        }

        function textBelongsToAssistant(node) {
            const element = node && node.nodeType === 3 ? node.parentElement : node;
            if (!element) return false;
            if (messages.mutationTouchesElement({ target: element }, trackedAssistantElement)) return true;
            return Boolean(messages.canonicalAssistant(element));
        }

        function onConversationMutations(mutations) {
            if (!boundRoot || boundRoot.isConnected === false) {
                rootWatcher.checkConnection();
                return;
            }
            let relevant = false;
            for (let i = 0; i < mutations.length; i += 1) {
                const mutation = mutations[i];
                if (messages.mutationTouchesElement(mutation, trackedAssistantElement)) {
                    relevant = true;
                } else if (mutation.type === "characterData") {
                    if (textBelongsToAssistant(mutation.target)) relevant = true;
                } else if (mutation.type === "childList" && messages.mutationAddsMessage(mutation)) {
                    relevant = true;
                } else if (mutation.type === "attributes") {
                    const name = mutation.attributeName || "";
                    if (name === "aria-busy" || name === "data-testid" || name === "aria-label" || name === "disabled") {
                        relevant = true;
                    }
                }
            }
            if (relevant || upgradeRootIfNeeded()) scheduleSnapshot();
        }

        function bindSurface(root) {
            if (conversationObserver) conversationObserver.disconnect();
            if (composerObserver) composerObserver.disconnect();
            composerObserver = null;
            boundComposer = null;
            boundRoot = root;
            boundRootSelector = messages.describeRoot(root);
            conversationObserver = new MutationObserver(onConversationMutations);
            conversationObserver.observe(root, {
                childList: true,
                subtree: true,
                characterData: true,
            });
            syncComposerObserver();
            scheduleSnapshot();
        }

        function syncComposerObserver() {
            const next = findComposer(boundRoot);
            if (next && next === boundComposer && composerObserver) return;
            if (composerObserver) composerObserver.disconnect();
            composerObserver = null;
            boundComposer = next || null;
            lastObservedComposerState = null;
            if (!boundComposer) return;
            debug("COMPOSER_ROOT_FOUND", {
                tag: boundComposer.tagName || null,
            });
            lastObservedComposerState = readComposerObservation(boundRoot).state;
            composerObserver = new MutationObserver(function () {
                const state = readComposerObservation(boundRoot).state;
                if (state === lastObservedComposerState) return;
                lastObservedComposerState = state;
                scheduleSnapshot();
            });
            composerObserver.observe(boundComposer, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["aria-label", "data-testid", "aria-busy", "disabled", "type"],
            });
        }

        function baselineRoot(root, replaced) {
            trackedAssistantElement = null;
            trackedAssistantId = null;
            const assistants = messages.findAssistantMessages(root);
            baselineAssistantIds = new Set(messages.messageIds(assistants));
            const model = readModel(root);
            rememberSignature(model);
            const phase = controller.getState().phase;
            if (!replaced || phase === "IDLE") {
                controller.noteBaseline(model);
            }
        }

        function upgradeRootIfNeeded() {
            const next = queryPreferredRoot();
            if (!next || next === boundRoot || next.isConnected === false) return false;
            if (messages.rootRank(next) <= messages.rootRank(boundRoot)) return false;
            debug("ROOT_FOUND", {
                replaced: true,
                upgraded: true,
                tag: next.tagName || null,
                selector: messages.describeRoot(next),
            });
            bindSurface(next);
            return true;
        }

        let lastPathname = location.pathname;
        const rootWatcher = createRootWatcher({
            queryRoot: queryPreferredRoot,
            observeUntilRoot: function (onMutate) {
                const observer = new MutationObserver(onMutate);
                observer.observe(document.documentElement, { childList: true, subtree: true });
                return observer;
            },
            observeParent: function (root, onMutate) {
                const parent = root.parentElement || document.documentElement;
                const observer = new MutationObserver(onMutate);
                observer.observe(parent, { childList: true });
                return observer;
            },
            onWaiting: function () {
                debug("WAITING_FOR_ROOT", { readyState: document.readyState });
            },
            onReplaced: function () {
                previousSignature = null;
                debug("ROOT_REPLACED", {});
            },
            onFound: function (root, info) {
                debug("ROOT_FOUND", {
                    replaced: Boolean(info && info.replaced),
                    tag: root.tagName || null,
                    selector: messages.describeRoot(root),
                });
                bindSurface(root);
                baselineRoot(root, Boolean(info && info.replaced));
            },
        });

        function controlFromEvent(event) {
            const target = event.target;
            if (!(target instanceof Element)) return null;
            const composer = findComposer(boundRoot);
            const inRoot = boundRoot && boundRoot.contains(target);
            const inComposer = composer && composer.contains(target);
            if (!inRoot && !inComposer) return null;
            return target.closest("button, [role='button']");
        }

        document.addEventListener("pointerdown", function (event) {
            const control = controlFromEvent(event);
            if (control && isStopControl(control)) controller.noteUserStopped();
        }, true);
        document.addEventListener("click", function (event) {
            const control = controlFromEvent(event);
            if (!control) return;
            if (isStopControl(control)) {
                controller.noteUserStopped();
                return;
            }
            if (isRegenerateControl(control)) {
                controller.noteUserTurnStarted({ source: "regenerate" });
                return;
            }
            if (isSendControl(control)) controller.noteUserTurnStarted({ source: "send" });
        }, true);
        document.addEventListener("keydown", function (event) {
            if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
            const target = event.target;
            if (!(target instanceof Element)) return;
            const composer = findComposer(boundRoot);
            if (!composer || !composer.contains(target)) return;
            controller.noteUserTurnStarted({ source: "keyboard" });
        }, true);

        chrome.runtime.onMessage.addListener(function (message) {
            if (!message || typeof message !== "object") return;
            if (message.type === "CHATGPT_NETWORK_HINT" && typeof message.hint === "string") {
                controller.noteNetwork(message.hint);
                return;
            }
            if (message.type === "CHATGPT_ROUTE_CHANGED") {
                previousSignature = null;
                controller.noteRouteChange(message.url || location.href);
                rootWatcher.checkConnection();
                rootWatcher.start();
                scheduleSnapshot();
            }
        });

        window.addEventListener("popstate", function () {
            previousSignature = null;
            controller.noteRouteChange(location.href);
            rootWatcher.start();
            scheduleSnapshot();
        });
        if (window.navigation && typeof window.navigation.addEventListener === "function") {
            window.navigation.addEventListener("navigatesuccess", function () {
                previousSignature = null;
                controller.noteRouteChange(location.href);
                rootWatcher.start();
                scheduleSnapshot();
            });
        }

        controller.noteRouteChange(location.href);
        rootWatcher.start();
    }
})();
