export const DEBUG = true;

const LOG_PREFIX = "[LLM Notifier]";

export function createLogger(moduleName) {
    const prefix = `${LOG_PREFIX}[${moduleName}]`;

    function safe(args) {
        return args.map(value => value instanceof Error
            ? `${value.name}: ${value.message}`.replace(/https?:\/\/[^\s]+/g, "[url]") : value);
    }
    return {
        debug: (...args) => {
            if (DEBUG) {
                console.log(prefix, new Date().toISOString(), ...safe(args));
            }
        },
        info: (...args) => console.log(prefix, new Date().toISOString(), ...safe(args)),
        warn: (...args) => console.warn(prefix, new Date().toISOString(), ...safe(args)),
        error: (...args) => console.error(prefix, new Date().toISOString(), ...safe(args)),
    };
}
