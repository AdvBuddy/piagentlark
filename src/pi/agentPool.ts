import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { PiRpcClient, type PiState } from './rpc.js';

export interface StoredConversation {
	sessionFile?: string;
	cwd?: string;
	model?: string;
	updatedAt: number;
}

interface StoreFile {
	version: 1;
	conversations: Record<string, StoredConversation>;
}

/**
 * Conversation -> pi session mapping, persisted so a bridge restart resumes
 * the same pi conversation instead of starting from scratch.
 */
export class SessionStore {
	private readonly filePath: string;
	private readonly logger: Logger;
	private conversations: Record<string, StoredConversation> = {};
	private saveTimer: NodeJS.Timeout | undefined;
	private dirty = false;

	constructor(dataDir: string, logger: Logger) {
		this.filePath = path.join(dataDir, 'sessions.json');
		this.logger = logger;
		mkdirSync(dataDir, { recursive: true });
		this.load();
	}

	private load(): void {
		if (!existsSync(this.filePath)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StoreFile>;
			if (parsed && typeof parsed === 'object' && parsed.conversations) {
				this.conversations = parsed.conversations;
			}
		} catch (error) {
			this.logger.warn(`无法读取会话映射 ${this.filePath}，将重新建立`, error);
		}
	}

	get(key: string): StoredConversation | undefined {
		return this.conversations[key];
	}

	set(key: string, patch: Partial<Omit<StoredConversation, 'updatedAt'>>): void {
		const previous = this.conversations[key];
		this.conversations[key] = { ...previous, ...patch, updatedAt: Date.now() };
		this.scheduleSave();
	}

	delete(key: string): void {
		if (!(key in this.conversations)) return;
		delete this.conversations[key];
		this.scheduleSave();
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.flush();
		}, 800);
	}

	flush(): void {
		if (!this.dirty) return;
		this.dirty = false;
		const payload: StoreFile = { version: 1, conversations: this.conversations };
		try {
			mkdirSync(path.dirname(this.filePath), { recursive: true });
			writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
		} catch (error) {
			this.logger.warn(`保存会话映射失败 ${this.filePath}`, error);
		}
	}

	close(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		this.flush();
	}
}

export interface AgentHandle {
	readonly key: string;
	readonly rpc: PiRpcClient;
	readonly cwd: string;
	readonly sessionFile?: string;
	model?: string;
	lastUsedAt: number;
	activeRuns: number;
}

export interface AgentOverrides {
	cwd?: string;
	model?: string;
}

/**
 * Owns one `pi --mode rpc` process per conversation. Agents are spawned
 * lazily, reused while warm, evicted when idle, and restored from the
 * persisted session file afterwards.
 */
export class AgentPool {
	private readonly config: Config;
	private readonly logger: Logger;
	private readonly store: SessionStore;
	private readonly handles = new Map<string, AgentHandle>();
	private readonly creating = new Map<string, Promise<AgentHandle>>();
	/** Spawn requests chained across keys so capacity checks cannot race. */
	private spawnTail: Promise<unknown> = Promise.resolve();
	private reaper: NodeJS.Timeout | undefined;
	private shuttingDown = false;

	constructor(config: Config, logger: Logger, store: SessionStore) {
		this.config = config;
		this.logger = logger;
		this.store = store;
	}

	start(): void {
		mkdirSync(this.config.pi.sessionDir, { recursive: true });
		const interval = Math.max(15_000, Math.min(60_000, Math.floor(this.config.pi.idleTimeoutMs / 4)));
		this.reaper = setInterval(() => {
			void this.reapIdle(false);
		}, interval);
		this.reaper.unref();
	}

	async get(key: string, cwdOverride?: string): Promise<AgentHandle> {
		const existing = this.handles.get(key);
		if (existing && existing.rpc.alive) {
			existing.lastUsedAt = Date.now();
			return existing;
		}
		const inFlight = this.creating.get(key);
		if (inFlight) return inFlight;

		// Launch one agent at a time: a concurrent get() for another key would
		// otherwise pass ensureCapacity() before either registers its handle.
		const creation = this.spawnTail.then(() => this.launchAgent(key, cwdOverride));
		this.spawnTail = creation.catch(() => undefined);
		const tracked = creation.finally(() => {
			this.creating.delete(key);
		});
		this.creating.set(key, tracked);
		return tracked;
	}

	/** Current handle without spawning one. */
	peek(key: string): AgentHandle | undefined {
		const handle = this.handles.get(key);
		return handle && handle.rpc.alive ? handle : undefined;
	}

	/** Remember a model chosen at runtime so a later spawn reuses it. */
	rememberModel(key: string, model: string): void {
		const handle = this.handles.get(key);
		if (handle) handle.model = model;
		this.store.set(key, { model });
	}

	/** Drop the process but keep the session file, so the next message reopens it. */
	async evict(key: string): Promise<void> {
		const handle = this.handles.get(key);
		if (!handle) return;
		this.handles.delete(key);
		await handle.rpc.close();
		this.logger.info(`会话 ${key} 已从内存中移除（会话文件保留）`);
	}

	/** Start over with a brand new pi session for this conversation. */
	async reset(key: string): Promise<void> {
		await this.evict(key);
		this.store.delete(key);
	}

	/** Re-spawn the agent with a new workspace or model. */
	async respawn(key: string, overrides: AgentOverrides): Promise<AgentHandle> {
		const previous = this.snapshot(key);
		await this.evict(key);
		const cwdChanged = overrides.cwd !== undefined && overrides.cwd !== previous.cwd;
		this.store.set(key, {
			sessionFile: cwdChanged ? undefined : previous.sessionFile,
			cwd: overrides.cwd ?? previous.cwd,
			model: overrides.model ?? previous.model,
		});
		return this.get(key);
	}

	getSessionFile(key: string): string | undefined {
		return this.handles.get(key)?.sessionFile ?? this.store.get(key)?.sessionFile;
	}

	getCwd(key: string): string {
		return this.handles.get(key)?.cwd ?? this.store.get(key)?.cwd ?? this.config.pi.cwd;
	}

	getModel(key: string): string | undefined {
		return this.handles.get(key)?.model ?? this.store.get(key)?.model ?? this.config.pi.model;
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.reaper) {
			clearInterval(this.reaper);
			this.reaper = undefined;
		}
		const closing = [...this.handles.values()].map(async (handle) => {
			try {
				await handle.rpc.close();
			} catch (error) {
				this.logger.debug(`关闭会话 ${handle.key} 失败`, error);
			}
		});
		this.handles.clear();
		await Promise.all(closing);
		this.store.close();
	}

	private snapshot(key: string): StoredConversation & { cwd: string } {
		const stored = this.store.get(key);
		return {
			sessionFile: this.handles.get(key)?.sessionFile ?? stored?.sessionFile,
			cwd: this.handles.get(key)?.cwd ?? stored?.cwd ?? this.config.pi.cwd,
			model: this.handles.get(key)?.model ?? stored?.model,
			updatedAt: stored?.updatedAt ?? Date.now(),
		};
	}

	private async launchAgent(key: string, cwdOverride?: string): Promise<AgentHandle> {
		await this.ensureCapacity();
		const stored = this.snapshot(key);
		const cwd = cwdOverride ?? stored.cwd;
		if (!existsSync(cwd)) {
			throw new Error(`工作目录不存在: ${cwd}`);
		}
		const model = stored.model ?? this.config.pi.model;
		return this.launch(key, cwd, model, stored.sessionFile, true);
	}

	private async launch(
		key: string,
		cwd: string,
		model: string | undefined,
		sessionFile: string | undefined,
		allowFreshRetry: boolean,
	): Promise<AgentHandle> {
		const rpc = new PiRpcClient({
			bin: this.config.pi.bin,
			args: this.buildArgs(key, sessionFile, model),
			cwd,
			env: process.env,
			label: key,
			logger: this.logger,
			requestTimeoutMs: this.config.pi.requestTimeoutMs,
		});
		await rpc.start();

		let state: PiState;
		try {
			state = await rpc.waitUntilReady(this.config.pi.readyTimeoutMs);
		} catch (error) {
			await rpc.close();
			if (sessionFile && allowFreshRetry) {
				this.logger.warn(`恢复会话失败，改为新会话重试 (${key})`, error);
				this.store.set(key, { sessionFile: undefined });
				return this.launch(key, cwd, model, undefined, false);
			}
			throw error;
		}

		const handle: AgentHandle = {
			key,
			rpc,
			cwd,
			sessionFile: state.sessionFile,
			model: state.model?.id ?? model,
			lastUsedAt: Date.now(),
			activeRuns: 0,
		};
		this.handles.set(key, handle);
		this.store.set(key, { sessionFile: state.sessionFile, cwd, model });
		rpc.onExit(() => {
			if (this.handles.get(key) === handle) {
				this.handles.delete(key);
				this.logger.warn(`pi 进程退出，会话 ${key} 将在下条消息时重启`);
			}
		});
		this.logger.info(
			`会话就绪 ${key} model=${state.model?.id ?? '(默认)'} session=${state.sessionFile ?? '(未持久化)'}`,
		);
		return handle;
	}

	private buildArgs(key: string, sessionFile: string | undefined, model: string | undefined): string[] {
		const args = ['--mode', 'rpc'];
		if (sessionFile && existsSync(sessionFile)) {
			args.push('--session', sessionFile);
		} else {
			args.push('--name', this.sessionName(key));
		}
		args.push('--session-dir', this.config.pi.sessionDir);
		if (model) args.push('--model', model);
		if (this.config.pi.thinking) args.push('--thinking', this.config.pi.thinking);
		if (this.config.pi.approveProjectFiles) args.push('--approve');
		args.push(...this.config.pi.extraArgs);
		return args;
	}

	private sessionName(key: string): string {
		const cleaned = key.replace(/[\r\n]/g, ' ').trim();
		return cleaned.length > 0 ? cleaned.slice(0, 80) : 'lark';
	}

	private async ensureCapacity(): Promise<void> {
		if (this.handles.size < this.config.pi.maxAgents) return;
		await this.reapIdle(true);
		if (this.handles.size < this.config.pi.maxAgents) return;
		throw new Error(
			`同时运行的 pi 会话已达上限 (${this.config.pi.maxAgents})，请稍后再试或调大 PI_MAX_AGENTS`,
		);
	}

	private async reapIdle(force: boolean): Promise<void> {
		if (this.shuttingDown) return;
		const now = Date.now();
		const candidates = [...this.handles.values()]
			.filter((handle) => handle.activeRuns === 0)
			.filter((handle) => force || now - handle.lastUsedAt > this.config.pi.idleTimeoutMs)
			.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
		for (const handle of candidates) {
			if (force && this.handles.size < this.config.pi.maxAgents) return;
			await this.evict(handle.key);
		}
	}
}
