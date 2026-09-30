import geminiProvider from "./gemini.js";
import chatgptProvider from "./chatgpt.js";

// Provider contract. Implement only the capabilities a site actually uses.
//
// name: string
// requestFilter + handleCompleted: webRequest completion, when the site has one
// handleBeforeRequest / handleError: optional earlier or failed webRequest phases
// handleRuntimeMessage(message, sender, context): optional content-script bridge
// navigation: { url, onHistoryStateUpdated(details) } optional history routing
//
// context.playNotification is the only audio entry. Providers do not open offscreen documents.
// A provider that does not need a capability omits it.

const providers = [geminiProvider, chatgptProvider];

export default providers;

