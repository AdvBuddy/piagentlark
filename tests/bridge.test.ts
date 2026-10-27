import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { PiLarkBridge } from '../src/bridge/bridge.js';
import { loadConfig, type Config } from '../src/config.js';
import { Logger } from '../src/logger.js';
import type { AgentHandle, AgentPool } from '../src/pi/agentPool.js';
import type { PiEvent } from '../src/pi/rpc.js';

const CHAT = 'oc_chat';
const KEY = `lark:${CHAT}`;

function makeConfig(overrides: NodeJS.ProcessEnv = {}): Config {
	const config = loadConfig({
		FEISHU_APP_ID: 'cli_test',
		FEISHU_APP_SECRET: 'secret',
		FEISHU_GROUP_POLICY: 'open',
		PI_CWD: process.cwd(),
		BRIDGE_DATA_DIR: '.pi-lark-test',
		...overrides,
	});
	config.bridge.cardUpdateIntervalMs = 200;
	return config;
}

function makeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
	return {
		messageId: 'om_msg_1',
		chatId: CHAT,
		chatType: 'p2p',
		senderId: 'ou_user',
		senderName: 'Tester',
		content: '你好',
		rawContentType: 'text',
		resources: [],
		mentions: [],
		mentionAll: false,
		mentionedBot: false,
		createTime: Date.now(),
		...overrides,
	};
}

type Listener = (event: PiEvent) => void;

class FakeRpc {
	readonly pid = 4242;
	alive = true;
	prompts: { message: string; options?: { streamingBehavior?: string; images?: unknown[] } }[] = [];
	aborts = 0;
	private readonly listeners = new Set<Listener>();

	onEvent(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onExit(): () => void {
		return () => undefined;
	}

	emit(event: PiEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	async prompt(message: string, options?: { streamingBehavior?: string; images?: unknown[] }): Promise<{ disposition: string }> {
		this.prompts.push({ message, options });
		return { disposition: 'started' };
	}

	async abort(): Promise<void> {
		this.aborts += 1;
		queueMicrotask(() => this.emit({ type: 'agent_settled', aborted: true }));
	}

	async getState(): Promise<Record<string, unknown>> {
		return { model: { provider: 'test', id: 'model-x' }, thinkingLevel: 'high', messageCount: 1 };
	}

	async getStats(): Promise<Record<string, unknown>> {
		return { tokens: { total: 1200 }, cost: 0.01, contextUsage: { percent: 5 } };
	}

	async setModel(provider: string, modelId: string): Promise<Record<string, unknown>> {
		return { provider, id: modelId };
	}

	async setThinkingLevel(): Promise<void> {
		return Promise.resolve();
	}

	async compact(): Promise<unknown> {
		return {};
	}

	async request(command: string): Promise<unknown> {
		if (command === 'get_available_models') {
			return { models: [{ provider: 'test', id: 'model-x' }, { provider: 'test', id: 'model-y' }] };
		}
		if (command === 'get_available_thinking_levels') {
			return { levels: ['off', 'high'] };
		}
		return {};
	}

	close(): Promise<void> {
		this.alive = false;
		return Promise.resolve();
	}
}

interface FakeHandle {
	key: string;
	rpc: FakeRpc;
	cwd: string;
	sessionFile?: string;
	model?: string;
	lastUsedAt: number;
	activeRuns: number;
}

class FakePool {
	readonly handles = new Map<string, FakeHandle>();
	readonly requested: string[] = [];
	readonly resets: string[] = [];
	failWith: Error | undefined;

	async get(key: string): Promise<AgentHandle> {
		if (this.failWith) throw this.failWith;
		this.requested.push(key);
		let handle = this.handles.get(key);
		if (!handle) {
			handle = {
				key,
				rpc: new FakeRpc(),
				cwd: 'C:\\work\\repo',
				sessionFile: undefined,
				model: undefined,
				lastUsedAt: Date.now(),
				activeRuns: 0,
			};
			this.handles.set(key, handle);
		}
		return handle as unknown as AgentHandle;
	}

	peek(key: string): AgentHandle | undefined {
		return this.handles.get(key) as unknown as AgentHandle | undefined;
	}

	getCwd(): string {
		return 'C:\\work\\repo';
	}

	getModel(): string | undefined {
		return undefined;
	}

	getSessionFile(): string | undefined {
		return undefined;
	}

	async reset(key: string): Promise<void> {
		this.resets.push(key);
		this.handles.delete(key);
	}

	rememberModel(): void {
		// no-op for tests
	}

	async respawn(key: string): Promise<AgentHandle> {
		this.handles.delete(key);
		return this.get(key);
	}

	async shutdown(): Promise<void> {
		// no-op for tests
	}

	rpcFor(key: string): FakeRpc {
		const handle = this.handles.get(key);
		assert.ok(handle, `expected an agent for ${key}`);
		return handle.rpc;
	}
}

interface SentMessage {
	to: string;
	input: Record<string, unknown>;
	opts?: Record<string, unknown>;
}

class FakeChannel {
	botIdentity = { openId: 'ou_bot', name: 'Pi Bot' };
	readonly initialCards: Record<string, unknown>[] = [];
	readonly updates: Record<string, unknown>[] = [];
	readonly sent: SentMessage[] = [];
	readonly reactions: string[] = [];
	readonly removedReactions: string[] = [];
	readonly replyTo: (string | undefined)[] = [];

	stream(
		to: string,
		input: { card: { initial: object; producer: (controller: unknown) => Promise<void> } },
		opts?: { replyTo?: string },
	): Promise<{ messageId: string }> {
		this.initialCards.push(input.card.initial as Record<string, unknown>);
		this.replyTo.push(opts?.replyTo);
		const controller = {
			messageId: 'om_card_1',
			current: {},
			update: async (next: object): Promise<void> => {
				this.updates.push(next as Record<string, unknown>);
			},
		};
		return (async () => {
			await input.card.producer(controller);
			return { messageId: controller.messageId };
		})();
	}

	async send(to: string, input: Record<string, unknown>, opts?: Record<string, unknown>): Promise<{ messageId: string }> {
		this.sent.push({ to, input, opts });
		return { messageId: `om_sent_${this.sent.length}` };
	}

	async addReaction(messageId: string, emoji: string): Promise<string> {
		this.reactions.push(`${messageId}:${emoji}`);
		return 'rid_1';
	}

	async removeReaction(messageId: string, id: string): Promise<void> {
		this.removedReactions.push(`${messageId}:${id}`);
	}

	get lastUpdate(): Record<string, unknown> | undefined {
		return this.updates.at(-1);
	}
}

function setup(env: NodeJS.ProcessEnv = {}) {
	const config = makeConfig(env);
	const channel = new FakeChannel();
	const pool = new FakePool();
	const logger = new Logger('test', 'error');
	// Keep expected failure paths out of the test output.
	logger.debug = () => undefined;
	logger.info = () => undefined;
	logger.warn = () => undefined;
	logger.error = () => undefined;
	const bridge = new PiLarkBridge(
		config,
		channel as unknown as LarkChannel,
		pool as unknown as AgentPool,
		logger,
	);
	return { config, channel, pool, bridge };
}

function flush(ms = 20): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Feed a message and let the background run reach the agent/prompt stage. */
async function send(bridge: PiLarkBridge, message: NormalizedMessage, wait = 20): Promise<void> {
	await bridge.onMessage(message);
	await flush(wait);
}

function cardText(card: Record<string, unknown> | undefined): string {
	return JSON.stringify(card ?? {});
}

function sentTexts(channel: FakeChannel): string[] {
	return channel.sent.map((message) => String(message.input.markdown ?? ''));
}

describe('PiLarkBridge', () => {
	it('streams a DM into a card and finalises when the agent settles', async () => {
		const { bridge, channel, pool } = setup();
		await send(bridge, makeMessage());

		const rpc = pool.rpcFor(KEY);
		assert.deepEqual(rpc.prompts[0]?.message, '你好');
		assert.equal(rpc.prompts[0]?.options?.streamingBehavior, undefined);
		assert.equal(channel.initialCards.length, 1);
		assert.deepEqual(channel.replyTo, ['om_msg_1']);

		rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你在' } });
		rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '忙什么' } });
		rpc.emit({ type: 'agent_settled', aborted: false });
		await flush(60);

		assert.match(cardText(channel.lastUpdate), /你在忙什么/);
		assert.match(cardText(channel.lastUpdate), /已完成/);
		assert.deepEqual(channel.reactions, ['om_msg_1:OnIt']);
		assert.deepEqual(channel.removedReactions, ['om_msg_1:rid_1']);
	});

	it('queues a second message as a follow-up while the run is active', async () => {
		const { bridge, channel, pool } = setup();
		await send(bridge, makeMessage({ content: '第一件事' }));
		await send(bridge, makeMessage({ messageId: 'om_msg_2', content: '顺便再查一下' }), 260);

		const rpc = pool.rpcFor(KEY);
		assert.equal(rpc.prompts.length, 2);
		assert.equal(rpc.prompts[1]?.options?.streamingBehavior, 'followUp');
		const rendered = channel.updates.map((update) => cardText(update)).join('\n');
		assert.match(rendered, /已排队/);
		assert.match(rendered, /顺便再查一下/);
	});

	it('isolates group conversations per sender and prefixes the sender name', async () => {
		const { bridge, pool } = setup({ FEISHU_GROUP_SESSIONS_PER_USER: 'false' });
		await send(
			bridge,
			makeMessage({ chatId: 'oc_group', chatType: 'group', messageId: 'om_g1', senderId: 'ou_a', senderName: 'Alice' }),
		);
		await send(
			bridge,
			makeMessage({ chatId: 'oc_group', chatType: 'group', messageId: 'om_g2', senderId: 'ou_b', senderName: 'Bob' }),
		);
		assert.deepEqual(pool.requested, ['lark:oc_group']);
		const rpc = pool.rpcFor('lark:oc_group');
		assert.match(String(rpc.prompts[0]?.message), /来自 Alice/);
		assert.match(String(rpc.prompts[1]?.message), /来自 Bob/);
	});

	it('creates one conversation per sender when group sessions are isolated', async () => {
		const { bridge, pool } = setup({ FEISHU_GROUP_SESSIONS_PER_USER: 'true' });
		await send(bridge, makeMessage({ chatId: 'oc_group', chatType: 'group', senderId: 'ou_a' }));
		await send(bridge, makeMessage({ chatId: 'oc_group', chatType: 'group', messageId: 'om_2', senderId: 'ou_b' }));
		assert.deepEqual(pool.requested, ['lark:oc_group:ou_a', 'lark:oc_group:ou_b']);
	});

	it('answers /help without touching the agent', async () => {
		const { bridge, channel, pool } = setup();
		await send(bridge, makeMessage({ content: '/help' }));
		assert.equal(pool.requested.length, 0);
		assert.match(sentTexts(channel)[0] ?? '', /Pi 机器人命令/);
		assert.equal(channel.sent[0]?.opts?.replyTo, 'om_msg_1');
	});

	it('stops the run on /stop and via the card button', async () => {
		const first = setup();
		await send(first.bridge, makeMessage());
		await send(first.bridge, makeMessage({ messageId: 'om_stop', content: '/stop' }));
		assert.equal(first.pool.rpcFor(KEY).aborts, 1);

		const second = setup();
		await send(second.bridge, makeMessage());
		await second.bridge.onCardAction({
			messageId: 'om_card_1',
			chatId: CHAT,
			operator: { openId: 'ou_user' },
			action: { value: { cmd: 'abort', key: KEY }, tag: 'button' },
		});
		assert.equal(second.pool.rpcFor(KEY).aborts, 1);
	});

	it('splits an over-long answer into a follow-up message', async () => {
		const { bridge, channel, pool } = setup({ BRIDGE_FINAL_CARD_CHARS: '500' });
		await send(bridge, makeMessage());
		const rpc = pool.rpcFor(KEY);
		rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'A'.repeat(800) } });
		rpc.emit({ type: 'agent_settled', aborted: false });
		await flush(60);

		assert.match(cardText(channel.lastUpdate), /完整内容见下方消息/);
		assert.ok(sentTexts(channel).some((text) => text.includes('（续）')), 'expected an overflow message');
	});

	it('rejects messages from senders outside the allowlist', async () => {
		const { bridge, channel, pool } = setup({ FEISHU_ALLOWED_USERS: 'ou_allowed' });
		await send(bridge, makeMessage({ senderId: 'ou_stranger' }));
		assert.equal(pool.requested.length, 0);
		assert.match(sentTexts(channel)[0] ?? '', /白名单/);
	});

	it('ignores peer bots unless allowed', async () => {
		const ignored = setup();
		await send(ignored.bridge, makeMessage({ raw: { sender: { sender_type: 'app' } } }));
		assert.equal(ignored.pool.requested.length, 0);

		const allowed = setup({ FEISHU_ALLOW_BOTS: 'all' });
		await send(allowed.bridge, makeMessage({ raw: { sender: { sender_type: 'app' } } }));
		assert.deepEqual(allowed.pool.requested, [KEY]);
	});

	it('reports a spawn failure on the card instead of hanging', async () => {
		const { bridge, channel, pool } = setup();
		pool.failWith = new Error('pi 不存在');
		await send(bridge, makeMessage(), 80);
		assert.match(cardText(channel.lastUpdate), /运行失败/);
		assert.match(cardText(channel.lastUpdate), /pi 不存在/);
	});

	it('prunes idle conversations from the state table', async () => {
		const { bridge, pool } = setup();
		await send(bridge, makeMessage());
		const rpc = pool.rpcFor(KEY);
		rpc.emit({ type: 'agent_settled', aborted: false });
		await flush(60);
		const states = (bridge as unknown as { states: Map<string, unknown> }).states;
		assert.equal(states.has(KEY), false);
	});

	it('rejects messages beyond the local queue cap', async () => {
		const { bridge, channel, pool } = setup({ BRIDGE_MAX_QUEUED_MESSAGES: '3' });
		await send(bridge, makeMessage({ content: '第一件事' }));
		const rpc = pool.rpcFor(KEY);
		// Force the follow-up path to fail so every extra message lands in the
		// local pending buffer.
		rpc.prompt = async () => {
			throw new Error('busy');
		};
		for (let i = 0; i < 3; i += 1) {
			await send(bridge, makeMessage({ messageId: `om_q${i}`, content: `排队 ${i}` }), 40);
		}
		await send(bridge, makeMessage({ messageId: 'om_over', content: '超限' }), 40);
		const texts = sentTexts(channel);
		assert.ok(texts.some((text) => text.includes('排队中的消息太多')), 'expected a queue-full notice');
		assert.equal(rpc.prompts.length, 1, 'the overflowing message must not reach pi');
	});

	it('answers /status, /model and /thinking from agent state', async () => {
		const { bridge, channel, pool } = setup();
		await send(bridge, makeMessage({ content: '/status' }));
		await send(bridge, makeMessage({ messageId: 'om_m', content: '/model' }));
		await send(bridge, makeMessage({ messageId: 'om_t', content: '/thinking high' }));
		const texts = sentTexts(channel);
		assert.match(texts[0] ?? '', /状态/);
		assert.match(texts[0] ?? '', /工作目录/);
		assert.match(texts[1] ?? '', /当前模型/);
		assert.match(texts[2] ?? '', /思考级别已设置为/);
		assert.ok(pool.handles.size > 0);
	});
});
