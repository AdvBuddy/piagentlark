import path from 'node:path';
import { collectAttachments } from './attachments.js';
import { buildCard, summarizeToolArgs } from './card.js';
import { collapseWhitespace, formatCost, formatDuration, formatTokens } from '../util/text.js';
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
const HELP_TEXT = [
    '**Pi 机器人命令**',
    '- `/help` 显示帮助',
    '- `/new` 开始全新会话（清空上下文）',
    '- `/stop` 中止当前运行',
    '- `/status` 查看会话、模型与用量',
    '- `/model` 查看当前模型，`/model <ID 或 provider/ID>` 切换',
    '- `/models [关键字]` 列出可用模型',
    '- `/thinking [级别]` 查看或切换思考级别',
    '- `/compact [说明]` 压缩上下文',
    '- `/cwd [目录]` 查看或切换工作目录（切换后开始新会话）',
    '- `/session` 查看当前 pi 会话文件',
    '- `/id` 查看当前会话标识（调试用）',
    '',
    '直接发消息即可与 Pi 对话；群聊中需要 @机器人。',
].join('\n');
/**
 * Routes Feishu/Lark messages to per-conversation pi agents and mirrors the
 * agent's stream back into an interactive card.
 */
export class PiLarkBridge {
    config;
    channel;
    pool;
    logger;
    states = new Map();
    runSequence = 0;
    shuttingDown = false;
    constructor(config, channel, pool, logger) {
        this.config = config;
        this.channel = channel;
        this.pool = pool;
        this.logger = logger;
    }
    async onMessage(message) {
        if (this.shuttingDown)
            return;
        const text = (message.content ?? '').trim();
        if (text.length === 0 && message.resources.length === 0)
            return;
        if (this.isPeerBot(message) && !this.peerBotAllowed(message)) {
            this.logger.debug(`忽略其他机器人的消息 ${message.messageId}`);
            return;
        }
        if (!this.senderAllowed(message.senderId)) {
            this.logger.warn(`忽略未授权用户 ${message.senderId} 的私聊消息`);
            await this.replyMarkdown(message.chatId, '当前机器人仅对白名单用户开放。', message.messageId).catch(() => undefined);
            return;
        }
        if (!this.groupAllowed(message)) {
            this.logger.debug(`群 ${message.chatId} 策略拒绝发送者 ${message.senderId}`);
            return;
        }
        if (text.startsWith('/')) {
            let handled = false;
            try {
                handled = await this.handleCommand(message, text);
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                this.logger.warn(`命令 ${text} 执行失败`, error);
                await this.replyMarkdown(message.chatId, `命令执行失败：${collapseWhitespace(detail, 300)}`, message.messageId).catch(() => undefined);
                handled = true;
            }
            if (handled)
                return;
        }
        const key = this.conversationKey(message);
        const state = this.stateFor(key);
        const request = await this.buildRequest(message, text);
        if (!request)
            return;
        if (state.run) {
            if (state.pending.length >= this.config.bridge.maxQueuedMessages) {
                this.logger.warn(`会话 ${key} 本地排队已满（${state.pending.length}），丢弃新消息 ${message.messageId}`);
                await this.replyMarkdown(message.chatId, '排队中的消息太多，请等当前任务完成后再发。', message.messageId).catch(() => undefined);
                return;
            }
            await this.queueIntoRun(state, state.run, request);
            return;
        }
        this.startRun(state, request);
    }
    async onCardAction(event) {
        if (this.shuttingDown)
            return;
        if (!this.senderAllowed(event.operator.openId))
            return;
        const value = event.action.value;
        if (typeof value !== 'object' || value === null)
            return;
        const record = value;
        if (record.cmd !== 'abort' || !record.key)
            return;
        const run = this.states.get(record.key)?.run;
        if (!run)
            return;
        await this.abortRun(run, '用户点击了停止');
    }
    async onBotAdded(chatId, botName) {
        const name = botName ? `${botName} ` : '';
        await this.channel
            .send(chatId, {
            markdown: `**${name}已连接到 Pi 编码代理**\n\n直接在对话中描述任务即可；发送 \`/help\` 查看全部命令。`,
        })
            .catch((error) => this.logger.warn('发送欢迎消息失败', error));
    }
    async shutdown() {
        this.shuttingDown = true;
        const runs = [...this.states.values()].map((state) => state.run).filter((run) => !!run);
        await Promise.all(runs.map(async (run) => {
            if (run.handle) {
                await run.handle.rpc.abort().catch(() => undefined);
            }
            this.finalizeRun(run, 'aborted', '服务正在关闭').catch(() => undefined);
        }));
    }
    isPeerBot(message) {
        const raw = message.raw;
        return raw?.sender?.sender_type !== undefined && raw.sender.sender_type !== 'user';
    }
    peerBotAllowed(message) {
        const mode = this.config.lark.allowBots;
        if (mode === 'all')
            return true;
        if (mode === 'mentions')
            return message.mentionedBot;
        return false;
    }
    senderAllowed(senderId) {
        const allow = this.config.lark.allowedUsers;
        if (allow.length === 0)
            return true;
        return allow.includes(senderId);
    }
    groupAllowed(message) {
        if (message.chatType !== 'group')
            return true;
        const policy = this.config.lark.groupPolicy;
        if (policy === 'open')
            return true;
        if (policy === 'disabled')
            return false;
        return this.config.lark.allowedUsers.includes(message.senderId);
    }
    /** p2p chats use the chat id; shared groups optionally isolate per sender. */
    conversationKey(message) {
        const base = `lark:${message.chatId}`;
        if (message.chatType === 'group' && this.config.bridge.groupSessionsPerUser) {
            return `${base}:${message.senderId}`;
        }
        return base;
    }
    stateFor(key) {
        const existing = this.states.get(key);
        if (existing)
            return existing;
        const state = { key, pending: [] };
        this.states.set(key, state);
        return state;
    }
    async buildRequest(message, text) {
        const attachments = await collectAttachments(this.channel, message, this.config, this.logger);
        const sections = [];
        let body = text;
        if (message.chatType === 'group' &&
            !this.config.bridge.groupSessionsPerUser &&
            message.senderName &&
            body.length > 0) {
            body = `（来自 ${message.senderName}）\n${body}`;
        }
        if (body.length > 0)
            sections.push(body);
        if (attachments.notes.length > 0)
            sections.push(attachments.notes.join('\n'));
        if (sections.length === 0 && attachments.images.length === 0)
            return undefined;
        if (sections.length === 0)
            sections.push('请看这张图片。');
        return {
            chatId: message.chatId,
            messageId: message.messageId,
            senderId: message.senderId,
            senderName: message.senderName,
            chatType: message.chatType,
            text: sections.join('\n\n'),
            images: attachments.images,
        };
    }
    startRun(state, request) {
        const cwd = this.pool.getCwd(state.key);
        const run = {
            id: ++this.runSequence,
            key: state.key,
            title: `Pi · ${path.basename(cwd) || 'workspace'}`,
            chatId: request.chatId,
            sourceMessageId: request.messageId,
            status: 'working',
            startedAt: Date.now(),
            finalized: false,
            turnTexts: [],
            joinedTexts: '',
            joinedCount: 0,
            currentText: '',
            thinking: '',
            tools: new Map(),
            notices: [],
            queued: [],
            started: deferred(),
            done: deferred(),
            abortRequested: false,
        };
        state.run = run;
        run.timeoutTimer = setTimeout(() => {
            run.notices.push('超过最长运行时间，正在请求停止');
            void this.abortRun(run, '运行超时');
        }, this.config.pi.runTimeoutMs);
        // A live pi process already keeps the loop busy; never pin the process open.
        run.timeoutTimer.unref();
        void this.executeRun(state, run, request).catch((error) => {
            this.logger.error('运行 Pi 失败', error);
            void this.failRun(run, error);
        });
    }
    async executeRun(state, run, request) {
        const cardPromise = this.startCard(run);
        cardPromise.catch((error) => this.logger.warn('卡片流异常', error));
        void this.addWorkingReaction(run).then((reactionId) => {
            run.reactionId = reactionId;
        });
        let startTimer;
        try {
            await Promise.race([
                run.started.promise,
                new Promise((_, reject) => {
                    startTimer = setTimeout(() => reject(new Error('卡片创建超时')), 20_000);
                    startTimer.unref();
                }),
            ]);
        }
        finally {
            if (startTimer)
                clearTimeout(startTimer);
        }
        const handle = await this.pool.get(state.key);
        run.handle = handle;
        run.model = handle.model;
        handle.activeRuns += 1;
        handle.lastUsedAt = Date.now();
        run.unsubscribe = handle.rpc.onEvent((event) => this.onPiEvent(run, event));
        run.exitCleanup = handle.rpc.onExit(() => {
            if (!run.finalized)
                void this.finalizeRun(run, 'error', 'pi 进程已退出');
        });
        if (run.finalized) {
            handle.activeRuns = Math.max(0, handle.activeRuns - 1);
            return;
        }
        this.logger.info(`会话 ${state.key} 开始运行 #${run.id}（${request.images.length} 张图片）`);
        const { disposition } = await handle.rpc.prompt(request.text, { images: request.images });
        if (disposition === 'handled') {
            run.notices.push('命令已由 Pi 扩展直接处理');
            await this.finalizeRun(run, 'done');
        }
    }
    async queueIntoRun(state, run, request) {
        run.queued.push(request.text);
        // Only a display preview; keep it bounded on very chatty sessions.
        if (run.queued.length > 50)
            run.queued.splice(0, run.queued.length - 50);
        const handle = run.handle;
        if (!handle || run.finalized) {
            state.pending.push(request);
            return;
        }
        try {
            await handle.rpc.prompt(request.text, { images: request.images, streamingBehavior: 'followUp' });
            this.scheduleRender(run);
        }
        catch (error) {
            this.logger.warn('把消息加入 Pi 队列失败，改为本地排队', error);
            state.pending.push(request);
            this.scheduleRender(run);
        }
    }
    startCard(run) {
        const initial = buildCard(this.cardView(run), this.cardOptions());
        return this.channel
            .stream(run.chatId, {
            card: {
                initial,
                producer: async (controller) => {
                    run.controller = controller;
                    run.messageId = controller.messageId;
                    run.started.resolve();
                    if (run.finalized) {
                        // The run ended before the card existed; paint the final state once.
                        await this.render(run, undefined, true);
                        return;
                    }
                    await run.done.promise;
                },
            },
        }, { replyTo: run.sourceMessageId })
            .catch((error) => {
            run.started.reject(error);
            throw error;
        });
    }
    onPiEvent(run, event) {
        if (run.finalized)
            return;
        switch (event.type) {
            case 'message_start': {
                const message = event.message;
                if (message?.role === 'assistant')
                    run.currentText = '';
                return;
            }
            case 'message_update': {
                const update = event.assistantMessageEvent;
                if (!update)
                    return;
                if (update.type === 'text_delta' && typeof update.delta === 'string') {
                    run.currentText += update.delta;
                    this.scheduleRender(run);
                }
                else if (update.type === 'thinking_delta' && typeof update.delta === 'string') {
                    run.thinking += update.delta;
                    if (this.config.bridge.showThinking)
                        this.scheduleRender(run);
                }
                return;
            }
            case 'message_end': {
                const message = event.message;
                if (!message || message.role !== 'assistant')
                    return;
                const text = extractText(message.content);
                if (text.trim().length > 0)
                    run.turnTexts.push(text.trim());
                run.currentText = '';
                if (message.usage) {
                    run.usage = {
                        tokens: message.usage.totalTokens,
                        cost: message.usage.cost?.total,
                    };
                }
                if (message.stopReason === 'error' && message.errorMessage) {
                    run.notices.push(`模型错误：${collapseWhitespace(message.errorMessage, 200)}`);
                }
                this.scheduleRender(run);
                return;
            }
            case 'tool_execution_start': {
                const id = String(event.toolCallId ?? '');
                const name = String(event.toolName ?? 'tool');
                run.tools.set(id, {
                    id,
                    name,
                    summary: summarizeToolArgs(name, event.args),
                    status: 'running',
                });
                this.scheduleRender(run);
                return;
            }
            case 'tool_execution_end': {
                const id = String(event.toolCallId ?? '');
                const entry = run.tools.get(id);
                const failed = event.isError === true;
                const duration = typeof event.durationMs === 'number' ? event.durationMs : undefined;
                if (entry) {
                    entry.status = failed ? 'error' : 'done';
                    entry.durationMs = duration;
                }
                else {
                    run.tools.set(id, {
                        id,
                        name: String(event.toolName ?? 'tool'),
                        summary: '',
                        status: failed ? 'error' : 'done',
                        durationMs: duration,
                    });
                }
                this.scheduleRender(run);
                return;
            }
            case 'agent_settled': {
                const aborted = event.aborted === true || run.abortRequested;
                void this.finalizeRun(run, aborted ? 'aborted' : 'done');
                return;
            }
            case 'compaction_start': {
                run.notices.push('正在压缩上下文…');
                this.scheduleRender(run);
                return;
            }
            case 'compaction_end': {
                if (event.aborted === true)
                    run.notices.push('上下文压缩已中止');
                else if (typeof event.errorMessage === 'string') {
                    run.notices.push(`上下文压缩失败：${collapseWhitespace(event.errorMessage, 160)}`);
                }
                else
                    run.notices.push('上下文压缩完成');
                this.scheduleRender(run);
                return;
            }
            case 'auto_retry_start': {
                run.notices.push(`请求失败，自动重试 ${event.attempt ?? '?'}/${event.maxAttempts ?? '?'}`);
                this.scheduleRender(run);
                return;
            }
            case 'auto_retry_end': {
                if (event.success !== true) {
                    run.notices.push(`自动重试失败：${collapseWhitespace(String(event.finalError ?? '未知错误'), 160)}`);
                    this.scheduleRender(run);
                }
                return;
            }
            case 'extension_ui_request': {
                void this.handleExtensionUi(run, event);
                return;
            }
            case 'extension_error': {
                run.notices.push(`扩展错误：${collapseWhitespace(String(event.error ?? '未知错误'), 160)}`);
                this.scheduleRender(run);
                return;
            }
            default:
                return;
        }
    }
    async handleExtensionUi(run, event) {
        const id = String(event.id ?? '');
        const method = String(event.method ?? '');
        if (!id)
            return;
        if (method === 'notify') {
            run.notices.push(collapseWhitespace(String(event.message ?? ''), 160));
            this.scheduleRender(run);
            return;
        }
        if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
            const title = collapseWhitespace(String(event.title ?? '交互请求'), 80);
            run.notices.push(`已自动取消扩展请求「${title}」（飞书暂不支持该交互）`);
            this.scheduleRender(run);
            try {
                await run.handle?.rpc.respondToUi(id, { cancelled: true });
            }
            catch (error) {
                this.logger.debug('回复扩展 UI 请求失败', error);
            }
        }
    }
    currentAnswer(run) {
        // turnTexts only grows at message boundaries, so the join is cached and
        // recomputed once per turn instead of once per rendered frame.
        if (run.joinedCount !== run.turnTexts.length) {
            run.joinedTexts = run.turnTexts.join('\n\n');
            run.joinedCount = run.turnTexts.length;
        }
        if (run.currentText.trim().length === 0)
            return run.joinedTexts;
        return run.joinedTexts.length > 0 ? `${run.joinedTexts}\n\n${run.currentText}` : run.currentText;
    }
    cardView(run) {
        return {
            title: run.title,
            status: run.status,
            answer: this.currentAnswer(run),
            thinking: run.thinking,
            tools: [...run.tools.values()],
            notices: run.notices,
            queued: run.queued,
            footer: this.buildFooter(run),
            abortValue: { cmd: 'abort', key: run.key },
        };
    }
    cardOptions() {
        return {
            answerLimit: this.config.bridge.streamPreviewChars,
            showThinking: this.config.bridge.showThinking,
            showTools: this.config.bridge.showTools,
        };
    }
    buildFooter(run) {
        const parts = [];
        parts.push(`模型 ${run.model ?? this.pool.getModel(run.key) ?? '默认'}`);
        parts.push(`用时 ${formatDuration(Date.now() - run.startedAt)}`);
        if (this.config.bridge.showUsage) {
            const tokens = formatTokens(run.usage?.tokens);
            if (tokens)
                parts.push(`${tokens} tokens`);
            const cost = formatCost(run.usage?.cost);
            if (cost)
                parts.push(cost);
        }
        return parts.join(' · ');
    }
    scheduleRender(run) {
        if (run.finalized || run.renderTimer)
            return;
        run.renderTimer = setTimeout(() => {
            run.renderTimer = undefined;
            void this.render(run);
        }, this.config.bridge.cardUpdateIntervalMs);
    }
    async render(run, view, force = false) {
        const controller = run.controller;
        if (!controller || (run.finalized && !force))
            return;
        const card = buildCard(view ?? this.cardView(run), this.cardOptions());
        const json = JSON.stringify(card);
        if (json === run.lastRenderedJson)
            return;
        run.lastRenderedJson = json;
        try {
            await controller.update(card);
        }
        catch (error) {
            this.logger.debug('更新卡片失败', error);
        }
    }
    async finalizeRun(run, status, notice) {
        if (run.finalized)
            return;
        run.finalized = true;
        run.status = status;
        if (notice)
            run.notices.push(notice);
        if (run.renderTimer) {
            clearTimeout(run.renderTimer);
            run.renderTimer = undefined;
        }
        if (run.timeoutTimer) {
            clearTimeout(run.timeoutTimer);
            run.timeoutTimer = undefined;
        }
        run.unsubscribe?.();
        run.exitCleanup?.();
        run.queued = [];
        if (run.handle) {
            const handle = run.handle;
            handle.activeRuns = Math.max(0, handle.activeRuns - 1);
            handle.lastUsedAt = Date.now();
            const stats = await handle.rpc.getStats().catch(() => undefined);
            this.applyStats(run, stats);
        }
        const limit = this.config.bridge.finalCardChars;
        const answer = this.currentAnswer(run);
        const overflow = status !== 'aborted' && answer.length > limit ? answer.slice(limit) : '';
        const view = {
            ...this.cardView(run),
            status,
            answer: overflow ? `${answer.slice(0, limit).trimEnd()}\n\n_…完整内容见下方消息_` : answer,
            queued: [],
            footer: this.buildFooter(run),
        };
        await this.render(run, view, true);
        run.done.resolve();
        await this.clearReaction(run);
        const state = this.states.get(run.key);
        if (state?.run === run)
            state.run = undefined;
        if (overflow) {
            await this.channel
                .send(run.chatId, { markdown: `**（续）**\n\n${overflow}` }, { replyTo: run.sourceMessageId })
                .catch((error) => this.logger.warn('发送完整回答失败', error));
        }
        this.logger.info(`会话 ${run.key} 运行 #${run.id} 结束 status=${status} 用时=${formatDuration(Date.now() - run.startedAt)}`);
        if (state && state.pending.length > 0) {
            const next = state.pending.shift();
            if (next)
                this.startRun(state, next);
        }
        else {
            this.pruneIfIdle(state);
        }
    }
    /** Empty conversations leave the state table so long uptimes stay flat. */
    pruneIfIdle(state) {
        if (state && !state.run && state.pending.length === 0)
            this.states.delete(state.key);
    }
    applyStats(run, stats) {
        if (!stats)
            return;
        const tokens = tokensFromParts(stats.tokens);
        const cost = typeof stats.cost === 'number' ? stats.cost : stats.tokens?.cost?.total;
        if (tokens !== undefined || cost !== undefined) {
            run.usage = { tokens: tokens ?? run.usage?.tokens, cost: cost ?? run.usage?.cost };
        }
        const percent = stats.contextUsage?.percent;
        if (typeof percent === 'number' && this.config.bridge.showUsage) {
            run.notices.push(`上下文占用 ${percent}%`);
        }
    }
    async failRun(run, error) {
        const message = error instanceof Error ? error.message : String(error);
        run.notices.push(`运行失败：${collapseWhitespace(message, 300)}`);
        if (!run.controller) {
            await this.replyMarkdown(run.chatId, `Pi 运行失败：${collapseWhitespace(message, 500)}`, run.sourceMessageId).catch(() => undefined);
        }
        await this.finalizeRun(run, 'error');
        const home = this.config.lark.homeChannel;
        if (home && home !== run.chatId) {
            await this.notifyHome(`**pi-lark 运行失败**\n会话：\`${run.key}\`\n原因：${collapseWhitespace(message, 200)}`).catch((notifyError) => this.logger.warn('发送 home channel 告警失败', notifyError));
        }
    }
    async abortRun(run, reason) {
        if (run.finalized || run.abortRequested)
            return;
        run.abortRequested = true;
        run.notices.push(reason);
        this.scheduleRender(run);
        const handle = run.handle;
        if (!handle) {
            await this.finalizeRun(run, 'aborted');
            return;
        }
        try {
            await handle.rpc.abort();
        }
        catch (error) {
            this.logger.warn('中止 Pi 运行失败', error);
            await this.finalizeRun(run, 'aborted', '中止请求失败，已强制结束展示');
            return;
        }
        // The settle event usually finalizes first; this is a safety net.
        setTimeout(() => {
            if (!run.finalized)
                void this.finalizeRun(run, 'aborted');
        }, 5_000).unref();
    }
    async addWorkingReaction(run) {
        try {
            return await this.channel.addReaction(run.sourceMessageId, 'OnIt');
        }
        catch (error) {
            this.logger.debug('添加处理中表情失败', error);
            return undefined;
        }
    }
    async clearReaction(run) {
        if (!run.reactionId)
            return;
        const id = run.reactionId;
        run.reactionId = undefined;
        try {
            await this.channel.removeReaction(run.sourceMessageId, id);
        }
        catch (error) {
            this.logger.debug('移除处理中表情失败', error);
        }
    }
    async replyMarkdown(chatId, markdown, replyTo) {
        const options = replyTo ? { replyTo } : undefined;
        await this.channel.send(chatId, { markdown }, options);
    }
    async handleCommand(message, text) {
        const commandToken = text.split(/\s+/, 1)[0] ?? '';
        const command = commandToken.toLowerCase();
        const arg = text.slice(commandToken.length).trim();
        const key = this.conversationKey(message);
        const state = this.stateFor(key);
        switch (command) {
            case '/help':
            case '/?': {
                await this.replyMarkdown(message.chatId, HELP_TEXT, message.messageId);
                return true;
            }
            case '/stop':
            case '/abort': {
                if (!state.run) {
                    await this.replyMarkdown(message.chatId, '当前没有运行中的任务。', message.messageId);
                }
                else {
                    await this.abortRun(state.run, '用户请求停止');
                }
                return true;
            }
            case '/new':
            case '/reset': {
                state.pending = [];
                if (state.run)
                    await this.abortRun(state.run, '会话已重置');
                await this.pool.reset(key);
                this.pruneIfIdle(state);
                await this.replyMarkdown(message.chatId, '已开始新的 pi 会话，之前的上下文不再保留。', message.messageId);
                return true;
            }
            case '/status': {
                await this.replyMarkdown(message.chatId, await this.renderStatus(key), message.messageId);
                return true;
            }
            case '/model': {
                await this.replyMarkdown(message.chatId, await this.handleModelCommand(key, arg), message.messageId);
                return true;
            }
            case '/models': {
                await this.replyMarkdown(message.chatId, await this.handleModelsCommand(key, arg), message.messageId);
                return true;
            }
            case '/thinking': {
                await this.replyMarkdown(message.chatId, await this.handleThinkingCommand(key, arg), message.messageId);
                return true;
            }
            case '/compact': {
                await this.replyMarkdown(message.chatId, this.startCompaction(key, message.chatId, arg), message.messageId);
                return true;
            }
            case '/cwd': {
                await this.replyMarkdown(message.chatId, await this.handleCwdCommand(key, state, arg), message.messageId);
                return true;
            }
            case '/session': {
                const sessionFile = this.pool.getSessionFile(key);
                await this.replyMarkdown(message.chatId, sessionFile ? `当前会话文件：\n\`${sessionFile}\`` : '当前还没有持久化的会话文件（还未开始对话或使用了临时会话）。', message.messageId);
                return true;
            }
            case '/id':
            case '/whoami': {
                const botName = this.channel.botIdentity?.name ?? '(未知)';
                await this.replyMarkdown(message.chatId, [
                    `- 机器人：${botName}`,
                    `- 会话键：\`${key}\``,
                    `- chat_id：\`${message.chatId}\``,
                    `- 发送者：\`${message.senderId}\``,
                ].join('\n'), message.messageId);
                return true;
            }
            default:
                return false;
        }
    }
    async renderStatus(key) {
        const handle = this.pool.peek(key);
        const state = handle ? await handle.rpc.getState().catch(() => undefined) : undefined;
        const stats = handle ? await handle.rpc.getStats().catch(() => undefined) : undefined;
        const conversation = this.states.get(key);
        const lines = [
            `**状态** ${conversation?.run ? '运行中' : '空闲'}`,
            `- 模型：${state?.model?.id ?? this.pool.getModel(key) ?? '默认'}`,
            `- 思考级别：${state?.thinkingLevel ?? this.config.pi.thinking ?? '默认'}`,
            `- 工作目录：\`${this.pool.getCwd(key)}\``,
            `- pi 进程：${handle ? `运行中 (pid ${handle.rpc.pid ?? '?'})` : '未启动（下条消息时启动）'}`,
        ];
        const sessionFile = state?.sessionFile ?? this.pool.getSessionFile(key);
        if (sessionFile)
            lines.push(`- 会话文件：\`${sessionFile}\``);
        if (typeof state?.messageCount === 'number')
            lines.push(`- 会话消息数：${state.messageCount}`);
        if (conversation?.run)
            lines.push(`- 当前运行：#${conversation.run.id}（${formatDuration(Date.now() - conversation.run.startedAt)}）`);
        if (conversation && conversation.pending.length > 0)
            lines.push(`- 本地排队：${conversation.pending.length} 条`);
        if (stats) {
            const tokens = formatTokens(tokensFromParts(stats.tokens));
            if (tokens)
                lines.push(`- 累计 tokens：${tokens}`);
            const cost = formatCost(stats.cost);
            if (cost)
                lines.push(`- 累计费用：${cost}`);
            const percent = stats.contextUsage?.percent;
            if (typeof percent === 'number')
                lines.push(`- 上下文占用：${percent}%`);
        }
        return lines.join('\n');
    }
    async handleModelCommand(key, arg) {
        if (!arg) {
            const handle = this.pool.peek(key);
            const state = handle ? await handle.rpc.getState().catch(() => undefined) : undefined;
            const current = state?.model;
            const label = current ? `${current.provider ?? '?'}/${current.id ?? '?'}` : (this.pool.getModel(key) ?? '默认');
            return `当前模型：\`${label}\`\n用法：\`/model <模型ID>\` 或 \`/model <provider>/<模型ID>\``;
        }
        const handle = await this.pool.get(key);
        const current = await handle.rpc.getState().catch(() => undefined);
        const slash = arg.indexOf('/');
        const provider = slash > 0 ? arg.slice(0, slash) : (current?.model?.provider ?? '');
        const modelId = slash > 0 ? arg.slice(slash + 1) : arg;
        if (!provider) {
            return `无法确定模型所属的 provider，请使用 \`/model provider/${modelId}\` 的写法。`;
        }
        const model = await handle.rpc.setModel(provider, modelId);
        this.pool.rememberModel(key, `${provider}/${modelId}`);
        return `已切换模型：\`${model.provider ?? provider}/${model.id ?? modelId}\``;
    }
    async handleModelsCommand(key, keyword) {
        const handle = await this.pool.get(key);
        const data = await handle.rpc.request('get_available_models', undefined, 30_000);
        const models = data?.models ?? [];
        const needle = keyword.toLowerCase();
        const filtered = needle
            ? models.filter((model) => `${model.provider ?? ''}/${model.id ?? ''}`.toLowerCase().includes(needle))
            : models;
        if (filtered.length === 0)
            return '没有匹配的模型。';
        const lines = filtered.slice(0, 40).map((model) => `- \`${model.provider ?? '?'}/${model.id ?? '?'}\``);
        const suffix = filtered.length > 40 ? `\n- …共 ${filtered.length} 个，已省略 ${filtered.length - 40} 个` : '';
        return `**可用模型**（${filtered.length}）\n${lines.join('\n')}${suffix}\n\n切换：\`/model <provider>/<模型ID>\``;
    }
    async handleThinkingCommand(key, arg) {
        const handle = await this.pool.get(key);
        const levels = await handle.rpc
            .request('get_available_thinking_levels', undefined, 15_000)
            .catch(() => undefined);
        const available = levels?.levels ?? [];
        if (!arg) {
            const state = await handle.rpc.getState().catch(() => undefined);
            const list = available.length > 0 ? available.join(', ') : 'off, minimal, low, medium, high, xhigh, max';
            return `当前思考级别：\`${state?.thinkingLevel ?? '默认'}\`\n可选：${list}`;
        }
        await handle.rpc.setThinkingLevel(arg);
        const state = await handle.rpc.getState().catch(() => undefined);
        return `思考级别已设置为 \`${state?.thinkingLevel ?? arg}\``;
    }
    startCompaction(key, chatId, instructions) {
        void (async () => {
            try {
                const handle = await this.pool.get(key);
                await handle.rpc.compact(instructions || undefined);
                await this.channel.send(chatId, { markdown: '上下文压缩完成。' }).catch(() => undefined);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn('压缩上下文失败', error);
                await this.channel.send(chatId, { markdown: `压缩上下文失败：${collapseWhitespace(message, 300)}` }).catch(() => undefined);
            }
        })();
        return '正在压缩上下文，完成后会在这里提示（长会话可能需要数分钟）。';
    }
    async handleCwdCommand(key, state, arg) {
        const current = this.pool.getCwd(key);
        if (!arg)
            return `当前工作目录：\`${current}\`\n用法：\`/cwd <目录>\`（切换后会开始新会话）`;
        if (state.run)
            return '当前有任务在运行，请先发送 `/stop`。';
        const target = path.isAbsolute(arg) ? arg : path.resolve(current, arg);
        const handle = await this.pool.respawn(key, { cwd: target });
        return `工作目录已切换为 \`${handle.cwd}\`，并已开始新的 pi 会话。`;
    }
    async notifyHome(markdown) {
        const chat = this.config.lark.homeChannel;
        if (!chat)
            return;
        await this.channel.send(chat, { markdown });
    }
}
function extractText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (typeof block !== 'object' || block === null)
            continue;
        const record = block;
        if (record.type === 'text' && typeof record.text === 'string')
            parts.push(record.text);
    }
    return parts.join('\n');
}
function tokensFromParts(tokens) {
    if (!tokens)
        return undefined;
    if (typeof tokens.totalTokens === 'number' && tokens.totalTokens > 0)
        return tokens.totalTokens;
    if (typeof tokens.total === 'number' && tokens.total > 0)
        return tokens.total;
    const total = (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
    return total > 0 ? total : undefined;
}
