export const DEBUG = false;

const LOG_PREFIX = "[LLM Notifier]";

export function createLogger(moduleName) {
    const prefix = `${LOG_PREFIX}[${moduleName}]`;

    return {
        debug: (...args) => {
            if (DEBUG) {
                console.log(prefix, ...args);
            }
        },
        info: (...args) => console.log(prefix, ...args),
        warn: (...args) => console.warn(prefix, ...args),
        error: (...args) => console.error(prefix, ...args),
    };
}
