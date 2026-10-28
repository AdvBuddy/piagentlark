const LEVEL_WEIGHT = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};
export function parseLogLevel(value, fallback = 'info') {
    if (!value)
        return fallback;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
        return normalized;
    }
    return fallback;
}
function formatArg(arg) {
    if (arg instanceof Error) {
        return arg.stack ?? `${arg.name}: ${arg.message}`;
    }
    if (typeof arg === 'string')
        return arg;
    try {
        return JSON.stringify(arg);
    }
    catch {
        return String(arg);
    }
}
/**
 * Minimal leveled logger. Records go to stderr so stdout stays free for
 * process-managed protocol data.
 */
export class Logger {
    scope;
    level;
    constructor(scope, level) {
        this.scope = scope;
        this.level = level;
    }
    child(scope) {
        return new Logger(`${this.scope}:${scope}`, this.level);
    }
    isDebug() {
        return LEVEL_WEIGHT[this.level] <= LEVEL_WEIGHT.debug;
    }
    debug(message, ...args) {
        this.write('debug', message, args);
    }
    info(message, ...args) {
        this.write('info', message, args);
    }
    warn(message, ...args) {
        this.write('warn', message, args);
    }
    error(message, ...args) {
        this.write('error', message, args);
    }
    write(level, message, args) {
        if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level])
            return;
        const suffix = args.length > 0 ? ` ${args.map(formatArg).join(' ')}` : '';
        const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}${suffix}`;
        process.stderr.write(`${line}\n`);
    }
}
