import geminiProvider from "./gemini.js";
import chatgptProvider from "./chatgpt.js";

// Providers bridge content-script events to the shared notification queue.
const providers = [geminiProvider, chatgptProvider];

export default providers;

