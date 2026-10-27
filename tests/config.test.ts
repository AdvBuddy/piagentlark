import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeConfig, loadConfig } from '../src/config.js';

const baseEnv: NodeJS.ProcessEnv = {
	FEISHU_APP_ID: 'cli_test',
	FEISHU_APP_SECRET: 'secret',
	PI_CWD: process.cwd(),
};

describe('loadConfig', () => {
	it('requires the Feishu app credentials', () => {
		assert.throws(() => loadConfig({ PI_CWD: process.cwd() }), /FEISHU_APP_ID/);
		assert.throws(() => loadConfig({ FEISHU_APP_ID: 'cli_test' }), /FEISHU_APP_SECRET/);
	});

	it('applies Hermes-like defaults', () => {
		const config = loadConfig(baseEnv);
		assert.equal(config.lark.domain, 'feishu');
		assert.equal(config.lark.connectionMode, 'websocket');
		assert.equal(config.lark.groupPolicy, 'allowlist');
		assert.equal(config.lark.requireMention, true);
		assert.equal(config.lark.allowBots, 'none');
		assert.deepEqual(config.lark.allowedUsers, []);
		assert.equal(config.bridge.groupSessionsPerUser, true);
		assert.equal(config.bridge.maxQueuedMessages, 10);
		assert.equal(config.bridge.inboxMaxAgeMs, 7 * 24 * 60 * 60_000);
		assert.equal(config.pi.bin, 'pi');
		assert.equal(config.pi.approveProjectFiles, true);
		assert.equal(config.pi.maxAgents, 4);
		assert.equal(config.logLevel, 'info');
	});

	it('parses allowlists, enums and numbers', () => {
		const config = loadConfig({
			...baseEnv,
			FEISHU_DOMAIN: 'lark',
			FEISHU_CONNECTION_MODE: 'webhook',
			FEISHU_ALLOWED_USERS: 'ou_a, ou_b ,',
			FEISHU_GROUP_POLICY: 'open',
			FEISHU_REQUIRE_MENTION: 'false',
			FEISHU_ALLOW_BOTS: 'mentions',
			FEISHU_GROUP_SESSIONS_PER_USER: 'no',
			FEISHU_HOME_CHANNEL: 'oc_home',
			PI_MODEL: 'anthropic/claude-sonnet-4-5',
			PI_THINKING: 'high',
			PI_EXTRA_ARGS: '--tools  read,bash',
			PI_MAX_AGENTS: '2',
			BRIDGE_CARD_UPDATE_INTERVAL_MS: '500',
			BRIDGE_MAX_QUEUED_MESSAGES: '5',
			BRIDGE_INBOX_MAX_AGE_MS: '1000',
			LOG_LEVEL: 'debug',
		});
		assert.equal(config.lark.domain, 'lark');
		assert.equal(config.lark.connectionMode, 'webhook');
		assert.deepEqual(config.lark.allowedUsers, ['ou_a', 'ou_b']);
		assert.equal(config.lark.groupPolicy, 'open');
		assert.equal(config.lark.requireMention, false);
		assert.equal(config.lark.allowBots, 'mentions');
		assert.equal(config.lark.homeChannel, 'oc_home');
		assert.equal(config.bridge.groupSessionsPerUser, false);
		assert.equal(config.pi.model, 'anthropic/claude-sonnet-4-5');
		assert.equal(config.pi.thinking, 'high');
		assert.deepEqual(config.pi.extraArgs, ['--tools', 'read,bash']);
		assert.equal(config.pi.maxAgents, 2);
		assert.equal(config.bridge.cardUpdateIntervalMs, 500);
		assert.equal(config.bridge.maxQueuedMessages, 5);
		assert.equal(config.bridge.inboxMaxAgeMs, 1000);
		assert.equal(config.logLevel, 'debug');
	});

	it('falls back to defaults for unknown enum values and out-of-range numbers', () => {
		const config = loadConfig({
			...baseEnv,
			FEISHU_GROUP_POLICY: 'nonsense',
			FEISHU_ALLOW_BOTS: 'everyone',
			PI_MAX_AGENTS: '0',
			BRIDGE_FINAL_CARD_CHARS: '10',
		});
		assert.equal(config.lark.groupPolicy, 'allowlist');
		assert.equal(config.lark.allowBots, 'none');
		assert.equal(config.pi.maxAgents, 4);
		assert.equal(config.bridge.finalCardChars, 6_000);
	});

	it('rejects a missing PI_CWD', () => {
		assert.throws(() => loadConfig({ ...baseEnv, PI_CWD: 'definitely-not-a-real-dir-xyz' }), /PI_CWD 不存在/);
	});

	it('describeConfig summarises the setup', () => {
		const summary = describeConfig(loadConfig(baseEnv));
		assert.match(summary, /连接模式=websocket/);
		assert.match(summary, /群策略=allowlist/);
		assert.match(summary, /(不限)/);
	});
});
