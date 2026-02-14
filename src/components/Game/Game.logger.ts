type LogLevel = 'debug' | 'info' | 'warn';

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel) {
    currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

export const logger = {
    debug(tag: string, msg: string) {
        if (shouldLog('debug')) console.log(`[${tag}] ${msg}`);
    },
    info(tag: string, msg: string) {
        if (shouldLog('info')) console.log(`[${tag}] ${msg}`);
    },
    warn(tag: string, msg: string) {
        if (shouldLog('warn')) console.warn(`[${tag}] ${msg}`);
    },
};
