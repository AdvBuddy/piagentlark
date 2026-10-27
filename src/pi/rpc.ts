import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import type { Logger } from '../logger.js';
import { JsonlDecoder } from './jsonl.js';

export type PiEvent = Record<string, unknown> & { type: string };

export interface PiImage {
	type: 'image';
	data: string;
	mimeType: string;
}

export interface PiResponse {
	type: 'response';
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export interface PiModel {
	id?: string;
	name?: string;
	provider?: string;
	contextWindow?: number;
}

export interface PiState {
	model?: PiModel;
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	messageCount?: number;
	pendingMessageCount?: number;
}

export interface PiUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Messages report `totalTokens`, session statistics report `total`. */
	totalTokens?: number;
	total?: number;
	cost?: { total?: number };
}

export interface PiSessionStats {
	sessionFile?: string;
	sessionId?: string;
	toolCalls?: number;
	tokens?: PiUsage;
	cost?: number;
	contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
}

export interface PiSpawnOptions {
	bin: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	label: string;
	logger: Logger;
	requestTimeoutMs: number;
}

interface PendingRequest {
	command: string;
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const STDERR_TAIL_LINES = 40;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Client for `pi --mode rpc`: a long-lived child process speaking JSONL over
 * stdin/stdout. Commands are correlated by id; every non-response record is
 * forwarded to event listeners.
 */
export class PiRpcClient {
	readonly label: string;

	private readonly options: PiSpawnOptions;
	private readonly logger: Logger;
	private readonly lines = new JsonlDecoder();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventHandlers = new Set<(event: PiEvent) => void>();
	private readonly exitHandlers = new Set<(info: { code: number | null; signal: NodeJS.Signals | null }) => void>();
	private readonly stderrTail: string[] = [];

	private child: ChildProcess | undefined;
	private stderrRemainder = '';
	private sequence = 0;
	private closing = false;
	private exited = true;

	constructor(options: PiSpawnOptions) {
		this.options = options;
		this.logger = options.logger;
		this.label = options.label;
	}

	get alive(): boolean {
		return this.child !== undefined && !this.closing && !this.exited;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	async start(): Promise<void> {
		if (this.child) return;
		this.closing = false;
		this.exited = false;
		this.logger.info(`启动 pi: ${this.options.bin} ${this.options.args.join(' ')} (cwd=${this.options.cwd})`);
		const child = spawn(this.options.bin, this.options.args, {
			cwd: this.options.cwd,
			env: this.options.env,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
		this.child = child;

		child.stdout?.on('data', (chunk: Buffer) => this.ingest(chunk));
		child.stderr?.on('data', (chunk: Buffer) => this.ingestStderr(chunk));
		child.on('error', (error) => {
			this.logger.error('pi 进程错误', error);
			this.exited = true;
			this.child = undefined;
			this.rejectAll(new Error(`pi 进程错误: ${error.message}${this.stderrSummary()}`));
		});
		child.on('exit', (code, signal) => {
			const wasClosing = this.closing;
			this.exited = true;
			this.child = undefined;
			this.rejectAll(new Error(`pi 进程已退出 (code=${code}, signal=${signal})${this.stderrSummary()}`));
			if (!wasClosing) {
				this.logger.warn(`pi 进程意外退出 code=${code} signal=${signal}`);
			} else {
				this.logger.debug(`pi 进程已关闭 code=${code} signal=${signal}`);
			}
			for (const handler of this.exitHandlers) {
				try {
					handler({ code, signal });
				} catch (error) {
					this.logger.debug('pi exit 监听器异常', error);
				}
			}
		});
	}

	/** Poll get_state until the agent answers, so callers know the run loop is live. */
	async waitUntilReady(timeoutMs: number): Promise<PiState> {
		const deadline = Date.now() + timeoutMs;
		let lastError: unknown;
		while (Date.now() < deadline) {
			if (this.exited) {
				throw new Error(`pi 启动后立即退出${this.stderrSummary()}`);
			}
			try {
				const state = await this.request<PiState>('get_state', undefined, 5_000);
				return state ?? {};
			} catch (error) {
				lastError = error;
				await sleep(400);
			}
		}
		const detail = lastError instanceof Error ? lastError.message : String(lastError ?? '未知错误');
		throw new Error(`pi 在 ${timeoutMs}ms 内未就绪: ${detail}${this.stderrSummary()}`);
	}

	request<T = unknown>(command: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
		const id = `r${++this.sequence}`;
		const record: Record<string, unknown> = { id, type: command, ...payload };
		return new Promise<T>((resolve, reject) => {
			const timeout = timeoutMs ?? this.options.requestTimeoutMs;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`pi 命令 ${command} 超时 (${timeout}ms)`));
			}, timeout);
			this.pending.set(id, {
				command,
				resolve: (data) => resolve(data as T),
				reject,
				timer,
			});
			this.writeLine(record).catch((error: unknown) => {
				const entry = this.pending.get(id);
				if (!entry) return;
				clearTimeout(entry.timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	async prompt(
		message: string,
		options?: { images?: PiImage[]; streamingBehavior?: 'steer' | 'followUp' },
	): Promise<{ disposition?: string }> {
		const payload: Record<string, unknown> = { message };
		if (options?.images && options.images.length > 0) payload.images = options.images;
		if (options?.streamingBehavior) payload.streamingBehavior = options.streamingBehavior;
		const data = await this.request<{ disposition?: string }>('prompt', payload);
		return data ?? {};
	}

	async abort(): Promise<void> {
		await this.request('abort', undefined, 90_000);
	}

	async newSession(): Promise<{ cancelled?: boolean }> {
		const data = await this.request<{ cancelled?: boolean }>('new_session', undefined, 30_000);
		return data ?? {};
	}

	async getState(): Promise<PiState> {
		return (await this.request<PiState>('get_state')) ?? {};
	}

	async getStats(): Promise<PiSessionStats> {
		return (await this.request<PiSessionStats>('get_session_stats')) ?? {};
	}

	async setModel(provider: string, modelId: string): Promise<PiModel> {
		return (await this.request<PiModel>('set_model', { provider, modelId }, 30_000)) ?? {};
	}

	async setThinkingLevel(level: string): Promise<void> {
		await this.request('set_thinking_level', { level }, 30_000);
	}

	async compact(customInstructions?: string): Promise<unknown> {
		const payload = customInstructions ? { customInstructions } : undefined;
		return this.request('compact', payload, 10 * 60_000);
	}

	async setSessionName(name: string): Promise<void> {
		await this.request('set_session_name', { name }, 15_000);
	}

	respondToUi(requestId: string, payload: Record<string, unknown>): Promise<void> {
		return this.writeLine({ type: 'extension_ui_response', id: requestId, ...payload });
	}

	onEvent(handler: (event: PiEvent) => void): () => void {
		this.eventHandlers.add(handler);
		return () => this.eventHandlers.delete(handler);
	}

	onExit(handler: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): () => void {
		this.exitHandlers.add(handler);
		return () => this.exitHandlers.delete(handler);
	}

	/** Close stdin for an orderly shutdown, then escalate to a process-tree kill. */
	async close(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.closing = true;
		try {
			child.stdin?.end();
		} catch {
			// best effort
		}
		const exited = await this.waitForExit(5_000);
		if (!exited) {
			this.logger.warn('pi 未在 5s 内退出，强制结束进程树');
			await this.killTree();
			await this.waitForExit(3_000);
		}
	}

	private waitForExit(timeoutMs: number): Promise<boolean> {
		const child = this.child;
		if (!child || this.exited) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				child.off('exit', onExit);
				resolve(false);
			}, timeoutMs);
			const onExit = (): void => {
				clearTimeout(timer);
				resolve(true);
			};
			child.once('exit', onExit);
		});
	}

	private async killTree(): Promise<void> {
		const child = this.child;
		const pid = child?.pid;
		if (!pid) return;
		// taskkill argv is built from this value, so only ever pass a real pid.
		if (!Number.isSafeInteger(pid) || pid <= 0) return;
		if (process.platform === 'win32') {
			await new Promise<void>((resolve) => {
				const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
				killer.on('exit', () => resolve());
				killer.on('error', () => resolve());
			});
			return;
		}
		try {
			child.kill('SIGKILL');
		} catch {
			// best effort
		}
	}

	private ingest(chunk: Buffer): void {
		for (const line of this.lines.push(chunk)) this.handleLine(line);
	}

	private ingestStderr(chunk: Buffer): void {
		const text = this.stderrRemainder + chunk.toString('utf8');
		const lines = text.split(/\r?\n/);
		this.stderrRemainder = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.trim()) continue;
			this.stderrTail.push(line);
			if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
			this.logger.debug(`pi[${this.label}] ${line}`);
		}
	}

	private handleLine(line: string): void {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			this.logger.warn('无法解析 pi 输出', line.slice(0, 300));
			return;
		}
		if (typeof record !== 'object' || record === null) return;
		const typed = record as PiEvent;
		if (typed.type === 'response') {
			this.handleResponse(typed as unknown as PiResponse);
			return;
		}
		this.emitEvent(typed);
	}

	private handleResponse(response: PiResponse): void {
		const id = response.id;
		if (!id) {
			// Parse errors arrive without a request id; nothing to correlate.
			if (!response.success) this.logger.warn(`pi 拒绝命令 ${response.command}: ${response.error ?? '未知错误'}`);
			return;
		}
		const entry = this.pending.get(id);
		if (!entry) {
			this.logger.debug(`收到未知请求的响应 id=${id} command=${response.command}`);
			return;
		}
		clearTimeout(entry.timer);
		this.pending.delete(id);
		if (response.success) {
			entry.resolve(response.data);
		} else {
			entry.reject(new Error(`pi 命令 ${response.command} 失败: ${response.error ?? '未知错误'}`));
		}
	}

	private emitEvent(event: PiEvent): void {
		for (const handler of this.eventHandlers) {
			try {
				handler(event);
			} catch (error) {
				this.logger.error('pi 事件处理异常', error);
			}
		}
	}

	private rejectAll(error: Error): void {
		for (const [id, entry] of this.pending) {
			clearTimeout(entry.timer);
			this.pending.delete(id);
			entry.reject(error);
		}
	}

	private writeLine(record: Record<string, unknown>): Promise<void> {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed) {
			return Promise.reject(new Error('pi 进程未运行'));
		}
		const line = `${JSON.stringify(record)}\n`;
		return new Promise<void>((resolve, reject) => {
			const drained = stdin.write(line, (error) => {
				if (error) reject(error);
				else resolve();
			});
			if (drained === false) {
				const timer = setTimeout(() => resolve(), 10_000);
				stdin.once('drain', () => {
					clearTimeout(timer);
					resolve();
				});
			}
		});
	}

	private stderrSummary(): string {
		if (this.stderrTail.length === 0) return '';
		const tail = this.stderrTail.slice(-8).join('\n');
		return `\npi stderr:\n${tail}`;
	}
}
