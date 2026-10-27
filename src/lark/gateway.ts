import { createLarkChannel, Domain, LoggerLevel, type LarkChannel } from '@larksuiteoapi/node-sdk';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';

function sdkLoggerLevel(level: Config['logLevel']): LoggerLevel {
	switch (level) {
		case 'debug':
			return LoggerLevel.debug;
		case 'warn':
			return LoggerLevel.warn;
		case 'error':
			return LoggerLevel.error;
		default:
			return LoggerLevel.info;
	}
}

/**
 * Build the Feishu/Lark channel with the same safety pipeline Hermes uses:
 * dedup, burst batching, per-chat serialization, mention gating and an
 * allowlist policy.
 */
export function createGateway(config: Config, logger: Logger): LarkChannel {
	const { lark, bridge } = config;
	return createLarkChannel({
		appId: lark.appId,
		appSecret: lark.appSecret,
		transport: lark.connectionMode,
		domain: lark.domain === 'lark' ? Domain.Lark : Domain.Feishu,
		webhook: {
			verificationToken: lark.verificationToken,
			encryptKey: lark.encryptKey,
		},
		safety: {
			dedup: { ttl: bridge.dedupTtlMs, maxEntries: bridge.dedupMaxEntries },
			batch: {
				text: { delayMs: bridge.textBatchDelayMs, maxMessages: 8, maxChars: 4000 },
				media: { delayMs: 800, maxItems: 8 },
			},
			chatQueue: { enabled: true },
		},
		policy: {
			requireMention: lark.requireMention,
			dmMode: lark.allowedUsers.length > 0 ? 'allowlist' : 'open',
			dmAllowlist: lark.allowedUsers,
			respondToMentionAll: false,
		},
		outbound: {
			streamThrottleMs: Math.max(300, Math.floor(bridge.cardUpdateIntervalMs / 2)),
			streamThrottleChars: 1_500,
			streamInitialText: '正在思考…',
			textChunkLimit: 4_000,
		},
		includeRawEvent: true,
		loggerLevel: sdkLoggerLevel(config.logLevel),
		logger: {
			error: (...args: unknown[]) => logger.error('[sdk]', ...args),
			warn: (...args: unknown[]) => logger.warn('[sdk]', ...args),
			info: (...args: unknown[]) => logger.debug('[sdk]', ...args),
			debug: (...args: unknown[]) => logger.debug('[sdk]', ...args),
			trace: (...args: unknown[]) => logger.debug('[sdk]', ...args),
		},
	});
}
