export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
	if (!value) return fallback;
	const normalized = value.trim().toLowerCase();
	if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
		return normalized;
	}
	return fallback;
}

function formatArg(arg: unknown): string {
	if (arg instanceof Error) {
		return arg.stack ?? `${arg.name}: ${arg.message}`;
	}
	if (typeof arg === 'string') return arg;
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}

/**
 * Minimal leveled logger. Records go to stderr so stdout stays free for
 * process-managed protocol data.
 */
export class Logger {
	private readonly scope: string;
	private readonly level: LogLevel;

	constructor(scope: string, level: LogLevel) {
		this.scope = scope;
		this.level = level;
	}

	child(scope: string): Logger {
		return new Logger(`${this.scope}:${scope}`, this.level);
	}

	isDebug(): boolean {
		return LEVEL_WEIGHT[this.level] <= LEVEL_WEIGHT.debug;
	}

	debug(message: string, ...args: unknown[]): void {
		this.write('debug', message, args);
	}

	info(message: string, ...args: unknown[]): void {
		this.write('info', message, args);
	}

	warn(message: string, ...args: unknown[]): void {
		this.write('warn', message, args);
	}

	error(message: string, ...args: unknown[]): void {
		this.write('error', message, args);
	}

	private write(level: LogLevel, message: string, args: unknown[]): void {
		if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
		const suffix = args.length > 0 ? ` ${args.map(formatArg).join(' ')}` : '';
		const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}${suffix}`;
		process.stderr.write(`${line}\n`);
	}
}
