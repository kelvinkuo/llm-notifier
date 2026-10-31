// Network HTTP completion is not a Gemini answer-completion signal.
export function createGeminiProvider() {
    const documents = new Map();
    return {
        name: "Gemini",
        handleRuntimeMessage(message, sender, { playNotification }) {
            if (message?.action !== "play_sound" || message.provider !== "Gemini") return;
            if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) return;
            try {
                if (new URL(sender.url).origin !== "https://gemini.google.com") return;
            } catch { return; }
            if (typeof message.session !== "string" || !message.session || message.session.length > 100
                || !Number.isSafeInteger(message.sequence) || message.sequence < 1) return;
            const key = `${sender.tab.id}:${sender.documentId || message.session}`;
            const previous = documents.get(key) || 0;
            if (message.sequence <= previous) return;
            documents.set(key, message.sequence);
            // Bounded, in-memory replay guard; no global notification cooldown.
            if (documents.size > 256) documents.delete(documents.keys().next().value);
            return playNotification();
        },
    };
}
export default createGeminiProvider();
