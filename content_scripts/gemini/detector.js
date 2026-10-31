(function () {
    "use strict";
    // Observed on Gemini Flash and Pro, 2026-10-30. Unknown/localized UI fails closed.
    const STOP = 'button[aria-label="Stop response"]';
    const SEND = 'button[aria-label="Send message"]';
    const INPUT = '[role="textbox"][contenteditable="true"][aria-label="Enter a prompt for Gemini"]';
    const DICTATE = 'button[aria-label^="Dictate"]';
    const ids = new WeakMap();
    let nextId = 0;
    let revision = 0;
    let pending = null;
    const session = crypto.randomUUID();
    function visible(element) {
        return Boolean(element && element.isConnected && element.getClientRects().length
            && !element.closest('[hidden],[aria-hidden="true"]'));
    }
    function control(selector) {
        return Array.from(document.querySelectorAll(selector)).find(visible);
    }
    function latestResponse() {
        const responses = document.querySelectorAll('model-response');
        return responses[responses.length - 1] || null;
    }
    function read() {
        controller.noteRoute(location.pathname.replace(/\/$/, '') || '/');
        const response = latestResponse();
        if (response && !ids.has(response)) ids.set(response, ++nextId);
        const content = response?.querySelector('message-content [aria-busy]');
        const actions = response?.querySelector('message-actions');
        const generating = Boolean(control(STOP));
        return {
            responseId: response ? ids.get(response) : null,
            revision,
            generating,
            busy: content?.getAttribute('aria-busy') === 'true',
            idle: !generating && Boolean(control(INPUT)) && Boolean(control(SEND) || control(DICTATE)),
            ready: content?.getAttribute('aria-busy') === 'false' && visible(actions)
                && Boolean(actions.querySelector('[data-test-id="thumb-up-button"]')),
            failed: Boolean(response?.querySelector('[role="alert"]')),
        };
    }
    const controller = GeminiCompletion.createController({
        read,
        onCompleted: ({ sequence }) => {
            chrome.runtime.sendMessage({ action: 'play_sound', provider: 'Gemini', session, sequence })
                .catch(() => {});
        },
    });
    function publish() {
        pending = null;
        controller.observe(read());
    }
    const observer = new MutationObserver(function (mutations) {
        const response = latestResponse();
        const content = response?.querySelector('message-content');
        if (content && mutations.some(m => (m.type === 'childList' || m.type === 'characterData')
            && content.contains(m.target))) revision += 1;
        // Capture even very short active phases before the coalesced idle snapshot.
        const view = read();
        if (view.generating || view.busy) controller.observe(view);
        if (pending === null) pending = setTimeout(publish, 50);
    });
    observer.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['aria-label', 'aria-busy', 'aria-hidden', 'hidden', 'disabled'],
    });
    function button(event) { return event.target?.closest?.('button'); }
    document.addEventListener('pointerdown', function (event) {
        if (button(event)?.matches(STOP)) controller.reset();
    }, true);
    document.addEventListener('click', function (event) {
        const target = button(event);
        if (target?.matches(STOP)) { controller.reset(); return; }
        // Invalidate before an SPA link can replace the conversation, including draft promotion.
        if (event.target?.closest?.('a[href]')) controller.reset();
        if (target?.matches(SEND) && !target.disabled) controller.submit(read());
    }, true);
    document.addEventListener('keydown', function (event) {
        if (event.isComposing) return;
        if ((event.key === 'Enter' || event.key === ' ') && button(event)?.matches(STOP)) controller.reset();
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
            && event.target?.matches?.(INPUT) && control(SEND) && !control(STOP)) controller.submit(read());
    }, true);
    window.addEventListener('popstate', () => { controller.reset(); publish(); });
    window.addEventListener('pagehide', () => controller.reset());
    publish(); // Baseline only: loading historical or in-progress responses never arms a turn.
})();
