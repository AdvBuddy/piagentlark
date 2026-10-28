import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PiRpcClient } from './rpc.js';
/**
 * Conversation -> pi session mapping, persisted so a bridge restart resumes
 * the same pi conversation instead of starting from scratch.
 */
export class SessionStore {
    filePath;
    logger;
    conversations = {};
    saveTimer;
    dirty = false;
    constructor(dataDir, logger) {
        this.filePath = path.join(dataDir, 'sessions.json');
        this.logger = logger;
        mkdirSync(dataDir, { recursive: true });
        this.load();
    }
    load() {
        if (!existsSync(this.filePath))
            return;
        try {
            const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
            if (parsed && typeof parsed === 'object' && parsed.conversations) {
                this.conversations = parsed.conversations;
            }
        }
        catch (error) {
            this.logger.warn(`无法读取会话映射 ${this.filePath}，将重新建立`, error);
        }
    }
    get(key) {
        return this.conversations[key];
    }
    set(key, patch) {
        const previous = this.conversations[key];
        this.conversations[key] = { ...previous, ...patch, updatedAt: Date.now() };
        this.scheduleSave();
    }
    delete(key) {
        if (!(key in this.conversations))
            return;
        delete this.conversations[key];
        this.scheduleSave();
    }
    scheduleSave() {
        this.dirty = true;
        if (this.saveTimer)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.flush();
        }, 800);
    }
    flush() {
        if (!this.dirty)
            return;
        this.dirty = false;
        const payload = { version: 1, conversations: this.conversations };
        try {
            mkdirSync(path.dirname(this.filePath), { recursive: true });
            writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        }
        catch (error) {
            this.logger.warn(`保存会话映射失败 ${this.filePath}`, error);
        }
    }
    close() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        this.flush();
    }
}
/**
 * Owns one `pi --mode rpc` process per conversation. Agents are spawned
 * lazily, reused while warm, evicted when idle, and restored from the
 * persisted session file afterwards.
 */
export class AgentPool {
    config;
    logger;
    store;
    handles = new Map();
    creating = new Map();
    /** Spawn requests chained across keys so capacity checks cannot race. */
    spawnTail = Promise.resolve();
    reaper;
    shuttingDown = false;
    constructor(config, logger, store) {
        this.config = config;
        this.logger = logger;
        this.store = store;
    }
    start() {
        mkdirSync(this.config.pi.sessionDir, { recursive: true });
        const interval = Math.max(15_000, Math.min(60_000, Math.floor(this.config.pi.idleTimeoutMs / 4)));
        this.reaper = setInterval(() => {
            void this.reapIdle(false);
        }, interval);
        this.reaper.unref();
    }
    async get(key, cwdOverride) {
        const existing = this.handles.get(key);
        if (existing && existing.rpc.alive) {
            existing.lastUsedAt = Date.now();
            return existing;
        }
        const inFlight = this.creating.get(key);
        if (inFlight)
            return inFlight;
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
    peek(key) {
        const handle = this.handles.get(key);
        return handle && handle.rpc.alive ? handle : undefined;
    }
    /** Remember a model chosen at runtime so a later spawn reuses it. */
    rememberModel(key, model) {
        const handle = this.handles.get(key);
        if (handle)
            handle.model = model;
        this.store.set(key, { model });
    }
    /** Drop the process but keep the session file, so the next message reopens it. */
    async evict(key) {
        const handle = this.handles.get(key);
        if (!handle)
            return;
        this.handles.delete(key);
        await handle.rpc.close();
        this.logger.info(`会话 ${key} 已从内存中移除（会话文件保留）`);
    }
    /** Start over with a brand new pi session for this conversation. */
    async reset(key) {
        await this.evict(key);
        this.store.delete(key);
    }
    /** Re-spawn the agent with a new workspace or model. */
    async respawn(key, overrides) {
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
    getSessionFile(key) {
        return this.handles.get(key)?.sessionFile ?? this.store.get(key)?.sessionFile;
    }
    getCwd(key) {
        return this.handles.get(key)?.cwd ?? this.store.get(key)?.cwd ?? this.config.pi.cwd;
    }
    getModel(key) {
        return this.handles.get(key)?.model ?? this.store.get(key)?.model ?? this.config.pi.model;
    }
    async shutdown() {
        this.shuttingDown = true;
        if (this.reaper) {
            clearInterval(this.reaper);
            this.reaper = undefined;
        }
        const closing = [...this.handles.values()].map(async (handle) => {
            try {
                await handle.rpc.close();
            }
            catch (error) {
                this.logger.debug(`关闭会话 ${handle.key} 失败`, error);
            }
        });
        this.handles.clear();
        await Promise.all(closing);
        this.store.close();
    }
    snapshot(key) {
        const stored = this.store.get(key);
        return {
            sessionFile: this.handles.get(key)?.sessionFile ?? stored?.sessionFile,
            cwd: this.handles.get(key)?.cwd ?? stored?.cwd ?? this.config.pi.cwd,
            model: this.handles.get(key)?.model ?? stored?.model,
            updatedAt: stored?.updatedAt ?? Date.now(),
        };
    }
    async launchAgent(key, cwdOverride) {
        await this.ensureCapacity();
        const stored = this.snapshot(key);
        const cwd = cwdOverride ?? stored.cwd;
        if (!existsSync(cwd)) {
            throw new Error(`工作目录不存在: ${cwd}`);
        }
        const model = stored.model ?? this.config.pi.model;
        return this.launch(key, cwd, model, stored.sessionFile, true);
    }
    async launch(key, cwd, model, sessionFile, allowFreshRetry) {
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
        let state;
        try {
            state = await rpc.waitUntilReady(this.config.pi.readyTimeoutMs);
        }
        catch (error) {
            await rpc.close();
            if (sessionFile && allowFreshRetry) {
                this.logger.warn(`恢复会话失败，改为新会话重试 (${key})`, error);
                this.store.set(key, { sessionFile: undefined });
                return this.launch(key, cwd, model, undefined, false);
            }
            throw error;
        }
        const handle = {
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
        this.logger.info(`会话就绪 ${key} model=${state.model?.id ?? '(默认)'} session=${state.sessionFile ?? '(未持久化)'}`);
        return handle;
    }
    buildArgs(key, sessionFile, model) {
        const args = ['--mode', 'rpc'];
        if (sessionFile && existsSync(sessionFile)) {
            args.push('--session', sessionFile);
        }
        else {
            args.push('--name', this.sessionName(key));
        }
        args.push('--session-dir', this.config.pi.sessionDir);
        if (model)
            args.push('--model', model);
        if (this.config.pi.thinking)
            args.push('--thinking', this.config.pi.thinking);
        if (this.config.pi.approveProjectFiles)
            args.push('--approve');
        args.push(...this.config.pi.extraArgs);
        return args;
    }
    sessionName(key) {
        const cleaned = key.replace(/[\r\n]/g, ' ').trim();
        return cleaned.length > 0 ? cleaned.slice(0, 80) : 'lark';
    }
    async ensureCapacity() {
        if (this.handles.size < this.config.pi.maxAgents)
            return;
        await this.reapIdle(true);
        if (this.handles.size < this.config.pi.maxAgents)
            return;
        throw new Error(`同时运行的 pi 会话已达上限 (${this.config.pi.maxAgents})，请稍后再试或调大 PI_MAX_AGENTS`);
    }
    async reapIdle(force) {
        if (this.shuttingDown)
            return;
        const now = Date.now();
        const candidates = [...this.handles.values()]
            .filter((handle) => handle.activeRuns === 0)
            .filter((handle) => force || now - handle.lastUsedAt > this.config.pi.idleTimeoutMs)
            .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
        for (const handle of candidates) {
            if (force && this.handles.size < this.config.pi.maxAgents)
                return;
            await this.evict(handle.key);
        }
    }
}
