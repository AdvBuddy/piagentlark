import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseLogLevel, type LogLevel } from './logger.js';

export type ConnectionMode = 'websocket' | 'webhook';
export type GroupPolicy = 'open' | 'allowlist' | 'disabled';
export type AllowBots = 'none' | 'mentions' | 'all';

export interface LarkConfig {
	appId: string;
	appSecret: string;
	domain: 'feishu' | 'lark';
	connectionMode: ConnectionMode;
	verificationToken?: string;
	encryptKey?: string;
	webhook: {
		host: string;
		port: number;
		path: string;
	};
	/** open_id allowlist for human senders. Empty means "no sender filter". */
	allowedUsers: string[];
	groupPolicy: GroupPolicy;
	requireMention: boolean;
	allowBots: AllowBots;
	/** Chat that receives unsolicited notifications (cron results, alerts). */
	homeChannel?: string;
}

export interface PiConfig {
	bin: string;
	cwd: string;
	sessionDir: string;
	model?: string;
	thinking?: string;
	extraArgs: string[];
	/** Trust project-local pi extensions/resources for each run. */
	approveProjectFiles: boolean;
	idleTimeoutMs: number;
	maxAgents: number;
	readyTimeoutMs: number;
	requestTimeoutMs: number;
	runTimeoutMs: number;
}

export interface BridgeConfig {
	/** Isolate session history per user inside shared group chats. */
	groupSessionsPerUser: boolean;
	showThinking: boolean;
	showTools: boolean;
	showUsage: boolean;
	/** Max characters of the answer rendered inside the card while streaming. */
	streamPreviewChars: number;
	/** Max characters of the answer kept in the final card. */
	finalCardChars: number;
	/** Min interval between card patches. */
	cardUpdateIntervalMs: number;
	maxImagesPerMessage: number;
	maxImageBytes: number;
	maxFileBytes: number;
	textBatchDelayMs: number;
	dedupTtlMs: number;
	dedupMaxEntries: number;
	/** Max messages buffered locally while a run is active; excess is rejected. */
	maxQueuedMessages: number;
	/** Age after which inbox attachment files are deleted; 0 disables cleanup. */
	inboxMaxAgeMs: number;
}

export interface Config {
	lark: LarkConfig;
	pi: PiConfig;
	bridge: BridgeConfig;
	dataDir: string;
	inboxDir: string;
	logLevel: LogLevel;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const raw = env[name];
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
	const value = envValue(env, name);
	if (!value) {
		throw new Error(`缺少必需的环境变量 ${name}（参见 .env.example）`);
	}
	return value;
}

function parseInteger(value: string | undefined, fallback: number, min = 0): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < min) return fallback;
	return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (!value) return fallback;
	const normalized = value.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	return fallback;
}

function parseList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function parseEnum<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
	if (!value) return fallback;
	const normalized = value.trim().toLowerCase();
	return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : fallback;
}

function parseArgs(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(/\s+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const appId = requireEnv(env, 'FEISHU_APP_ID');
	const appSecret = requireEnv(env, 'FEISHU_APP_SECRET');

	const dataDir = path.resolve(envValue(env, 'BRIDGE_DATA_DIR') ?? '.pi-lark');
	const inboxDir = path.join(dataDir, 'inbox');
	const piCwdRaw = envValue(env, 'PI_CWD');
	const piCwd = piCwdRaw ? path.resolve(piCwdRaw) : process.cwd();
	if (!existsSync(piCwd)) {
		throw new Error(`PI_CWD 不存在: ${piCwd}`);
	}
	const sessionDirRaw = envValue(env, 'PI_SESSION_DIR');
	const sessionDir = sessionDirRaw ? path.resolve(sessionDirRaw) : path.join(dataDir, 'pi-sessions');

	return {
		lark: {
			appId,
			appSecret,
			domain: parseEnum(env.FEISHU_DOMAIN, ['feishu', 'lark'] as const, 'feishu'),
			connectionMode: parseEnum(env.FEISHU_CONNECTION_MODE, ['websocket', 'webhook'] as const, 'websocket'),
			verificationToken: envValue(env, 'FEISHU_VERIFICATION_TOKEN'),
			encryptKey: envValue(env, 'FEISHU_ENCRYPT_KEY'),
			webhook: {
				host: envValue(env, 'FEISHU_WEBHOOK_HOST') ?? '127.0.0.1',
				port: parseInteger(envValue(env, 'FEISHU_WEBHOOK_PORT'), 8765, 1),
				path: envValue(env, 'FEISHU_WEBHOOK_PATH') ?? '/feishu/webhook',
			},
			allowedUsers: parseList(env.FEISHU_ALLOWED_USERS),
			groupPolicy: parseEnum(env.FEISHU_GROUP_POLICY, ['open', 'allowlist', 'disabled'] as const, 'allowlist'),
			requireMention: parseBoolean(envValue(env, 'FEISHU_REQUIRE_MENTION'), true),
			allowBots: parseEnum(env.FEISHU_ALLOW_BOTS, ['none', 'mentions', 'all'] as const, 'none'),
			homeChannel: envValue(env, 'FEISHU_HOME_CHANNEL'),
		},
		pi: {
			bin: envValue(env, 'PI_BIN') ?? 'pi',
			cwd: piCwd,
			sessionDir,
			model: envValue(env, 'PI_MODEL'),
			thinking: envValue(env, 'PI_THINKING'),
			extraArgs: parseArgs(envValue(env, 'PI_EXTRA_ARGS')),
			approveProjectFiles: parseBoolean(envValue(env, 'PI_APPROVE'), true),
			idleTimeoutMs: parseInteger(envValue(env, 'PI_IDLE_TIMEOUT_MS'), 30 * 60_000, 1_000),
			maxAgents: parseInteger(envValue(env, 'PI_MAX_AGENTS'), 4, 1),
			readyTimeoutMs: parseInteger(envValue(env, 'PI_READY_TIMEOUT_MS'), 60_000, 1_000),
			requestTimeoutMs: parseInteger(envValue(env, 'PI_REQUEST_TIMEOUT_MS'), 120_000, 1_000),
			runTimeoutMs: parseInteger(envValue(env, 'PI_RUN_TIMEOUT_MS'), 30 * 60_000, 10_000),
		},
		bridge: {
			groupSessionsPerUser: parseBoolean(envValue(env, 'FEISHU_GROUP_SESSIONS_PER_USER'), true),
			showThinking: parseBoolean(envValue(env, 'BRIDGE_SHOW_THINKING'), true),
			showTools: parseBoolean(envValue(env, 'BRIDGE_SHOW_TOOLS'), true),
			showUsage: parseBoolean(envValue(env, 'BRIDGE_SHOW_USAGE'), true),
			streamPreviewChars: parseInteger(envValue(env, 'BRIDGE_STREAM_PREVIEW_CHARS'), 4_000, 500),
			finalCardChars: parseInteger(envValue(env, 'BRIDGE_FINAL_CARD_CHARS'), 6_000, 500),
			cardUpdateIntervalMs: parseInteger(envValue(env, 'BRIDGE_CARD_UPDATE_INTERVAL_MS'), 900, 200),
			maxImagesPerMessage: parseInteger(envValue(env, 'BRIDGE_MAX_IMAGES'), 4, 0),
			maxImageBytes: parseInteger(envValue(env, 'BRIDGE_MAX_IMAGE_BYTES'), 8 * 1024 * 1024, 1024),
			maxFileBytes: parseInteger(envValue(env, 'BRIDGE_MAX_FILE_BYTES'), 50 * 1024 * 1024, 1024),
			textBatchDelayMs: parseInteger(envValue(env, 'BRIDGE_TEXT_BATCH_DELAY_MS'), 600, 0),
			dedupTtlMs: parseInteger(envValue(env, 'BRIDGE_DEDUP_TTL_MS'), 24 * 60 * 60_000, 60_000),
			dedupMaxEntries: parseInteger(envValue(env, 'BRIDGE_DEDUP_MAX_ENTRIES'), 2048, 64),
			maxQueuedMessages: parseInteger(envValue(env, 'BRIDGE_MAX_QUEUED_MESSAGES'), 10, 1),
			inboxMaxAgeMs: parseInteger(envValue(env, 'BRIDGE_INBOX_MAX_AGE_MS'), 7 * 24 * 60 * 60_000, 0),
		},
		dataDir,
		inboxDir,
		logLevel: parseLogLevel(envValue(env, 'LOG_LEVEL'), 'info'),
	};
}

/** Group chats require an @mention and honour the configured group policy. */
export function describeConfig(config: Config): string {
	const { lark, pi, bridge } = config;
	return [
		`飞书应用 ${lark.appId} (${lark.domain}) 连接模式=${lark.connectionMode}`,
		`允许用户=${lark.allowedUsers.length > 0 ? lark.allowedUsers.join(',') : '(不限)'} 群策略=${lark.groupPolicy} 必须@=${lark.requireMention}`,
		`pi 工作目录=${pi.cwd} 会话目录=${pi.sessionDir} 模型=${pi.model ?? '(默认)'}`,
		`卡片间隔=${bridge.cardUpdateIntervalMs}ms 批量延迟=${bridge.textBatchDelayMs}ms`,
	].join('\n');
}
